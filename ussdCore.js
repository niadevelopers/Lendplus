require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Store active sessions (clears after 30 min - shorter for better memory)
const sessions = new Map();

// Clean up old sessions every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of sessions.entries()) {
        if (now - data.timestamp > 1800000) { // 30 minutes
            sessions.delete(id);
        }
    }
    console.log(`🧹 Session cleanup. Active: ${sessions.size}`);
}, 1800000);

// Create payments log file
if (!fs.existsSync('payments.log')) {
    fs.writeFileSync('payments.log', '=== PAYMENTS LOG ===\n');
}

// ============================================
// PHONE NUMBER CONVERSION - Handles ALL Kenyan formats
// ============================================
function formatPhoneForPesaFlux(rawPhone) {
    // Remove any spaces, dashes, parentheses
    let cleaned = rawPhone.toString().replace(/[\s\-\(\)]/g, '');
    
    // Remove leading '+' if present
    cleaned = cleaned.replace(/^\+/, '');
    
    // Handle different prefixes
    if (cleaned.startsWith('254')) {
        // Already has 254, just ensure no extra zero after
        cleaned = cleaned.replace(/^2540+/, '254');
    } else if (cleaned.startsWith('0')) {
        // Starts with 0 (e.g., 0723... or 0123...)
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        // Starts with 7 or 1 (e.g., 723895598)
        cleaned = '254' + cleaned;
    }
    
    // Final validation: must be 12 digits starting with 2547 (Safaricom)
    if (!/^2547\d{8}$/.test(cleaned)) {
        return { valid: false, formatted: cleaned, error: "Enter a valid Safaricom number (e.g., 0722123456 or 254722123456)" };
    }
    
    return { valid: true, formatted: cleaned, error: null };
}

// ============================================
// MAIN USSD HANDLER
// ============================================
app.post('/ussd', async (req, res) => {
    const { sessionId, phoneNumber, text } = req.body;
    
    console.log(`📱 ${sessionId.slice(-6)} | ${phoneNumber} | Text: "${text}"`);
    
    const respond = (message, endSession = false) => {
        res.set('Content-Type', 'text/plain');
        res.send(`${endSession ? 'END' : 'CON'} ${message}`);
    };
    
    // NEW SESSION
    if (text === '') {
        sessions.set(sessionId, {
            phone: phoneNumber,
            step: 'welcome',
            timestamp: Date.now()
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
            session.step = 'asking_amount';
            sessions.set(sessionId, session);
            return respond(`Enter amount (500-50,000):`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Goodbye!`, true);
        } else {
            return respond(`1.Apply 2.Exit`);
        }
    }
    
    // ========== AMOUNT ==========
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
    
    // ========== PURPOSE ==========
    if (session.step === 'asking_purpose') {
        const purposeMap = { '1':'Business', '2':'School fees', '3':'Emergency', '4':'Other' };
        if (!purposeMap[inputs[currentLevel]]) {
            return respond(`1.Business 2.School 3.Emergency 4.Other`);
        }
        session.loanPurpose = purposeMap[inputs[currentLevel]];
        session.step = 'showing_terms';
        sessions.set(sessionId, session);
        return respond(`Terms:\nAmount: KES ${session.loanAmount}\nCollateral: KES ${session.collateral}\nRepay:30 days\nLate fee:50/day\n1.Accept 0.Decline`);
    }
    
    // ========== TERMS ==========
    if (session.step === 'showing_terms') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`Cancelled. Goodbye.`, true);
        }
        if (inputs[currentLevel] !== '1') {
            return respond(`1.Accept 0.Decline`);
        }
        session.step = 'asking_phone';
        sessions.set(sessionId, session);
        return respond(`Enter M-Pesa number for loan:\n(Format: 0722123456)`);
    }
    
    // ========== ASK FOR PHONE NUMBER (NEW STEP) ==========
    if (session.step === 'asking_phone') {
        const rawPhone = inputs[currentLevel];
        const phoneValidation = formatPhoneForPesaFlux(rawPhone);
        
        if (!phoneValidation.valid) {
            return respond(`Invalid number. ${phoneValidation.error}\nTry again (e.g., 0722123456):`);
        }
        
        // Store the validated phone number
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
        
        session.step = 'confirming_collateral';
        sessions.set(sessionId, session);
        
        return respond(`Pay collateral: KES ${session.collateral}\n1.Pay 0.Cancel`);
    }
    
    // ========== PAYMENT ==========
    if (session.step === 'confirming_collateral') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`Cancelled. Goodbye.`, true);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`1.Pay 0.Cancel`);
        }
        
        // ========== TRIGGER PESAFLUX STK PUSH ==========
        const orderRef = `LOAN-${sessionId.slice(-8)}-${Date.now()}`;
        const callbackUrl = `${req.protocol}://${req.get('host')}/pesaflux-callback`;
        
        // Use the customer's CONFIRMED phone number, NOT the session number
        const phoneToBill = session.customerPhone;
        
        console.log(`💳 STK: ${phoneToBill} | Amount: ${session.collateral}`);
        
        try {
            const pesafluxResponse = await axios.post(
                'https://pesaflux.com/api/stkpush',
                {
                    amount: session.collateral,
                    phone: phoneToBill,
                    order_ref: orderRef,
                    callback_url: callbackUrl
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.PESAFLUX_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                }
            );
            
            if (pesafluxResponse.data && pesafluxResponse.data.checkout_request_id) {
                session.checkoutId = pesafluxResponse.data.checkout_request_id;
                session.orderRef = orderRef;
                session.step = 'payment_sent';
                sessions.set(sessionId, session);
                
                // Log payment initiation
                fs.appendFileSync('payments.log', 
                    `${new Date().toISOString()} | INIT | Phone:${phoneToBill} | Amount:${session.collateral} | ID:${session.checkoutId}\n`
                );
                
                // END SESSION IMMEDIATELY - user checks phone for STK
                return respond(`✅ M-Pesa prompt sent to ${session.rawPhoneEntered}\nEnter PIN on your phone.\nWe'll SMS you confirmation.\nThank you!`, true);
            } else {
                throw new Error('No checkout ID');
            }
            
        } catch (error) {
            console.error('❌ PesaFlux Error:', error.response?.data || error.message);
            fs.appendFileSync('payments.log', 
                `${new Date().toISOString()} | FAIL | Phone:${phoneToBill} | Error:${error.message}\n`
            );
            return respond(`❌ Payment failed. Try again later.`, true);
        }
    }
    
    // ========== FALLBACK ==========
    return respond(`Error. Dial code again.`, true);
});

// ============================================
// PESAFLUX CALLBACK
// ============================================
app.post('/pesaflux-callback', async (req, res) => {
    const callbackData = req.body;
    
    console.log(`\n🔔 CALLBACK: ${new Date().toISOString()}`);
    console.log(JSON.stringify(callbackData, null, 2));
    
    fs.appendFileSync('payments.log', 
        `${new Date().toISOString()} | CALLBACK | ${JSON.stringify(callbackData)}\n`
    );
    
    let isSuccessful = false;
    let amount = null;
    let phone = null;
    let receipt = null;
    let checkoutId = null;
    
    // Handle PesaFlux response format
    if (callbackData.status === 'success' || callbackData.ResultCode === '0' || callbackData.ResultCode === 0) {
        isSuccessful = true;
        amount = callbackData.amount || callbackData.Amount;
        phone = callbackData.phone || callbackData.PhoneNumber;
        receipt = callbackData.mpesa_receipt_number || callbackData.MpesaReceiptNumber || callbackData.TransactionID;
        checkoutId = callbackData.checkout_request_id || callbackData.CheckoutRequestID;
    }
    
    if (isSuccessful) {
        const separator = '='.repeat(60);
        const successMessage = `
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
${separator}
`;
        
        console.log(successMessage);
        
        fs.appendFileSync('payments.log', `
${separator}
SUCCESS - ${new Date().toISOString()}
Phone: ${phone} | Amount: KES ${amount} | Receipt: ${receipt}
${separator}
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
        version: '2.0.0'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h2>✅ USSD Loan App v2</h2>
        <p>Status: Running | Sessions: ${sessions.size}</p>
        <p>POST /ussd - USSD endpoint</p>
        <p>POST /pesaflux-callback - Payment callback</p>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║     ✅ USSD LOAN APP v2 - DEPLOYED             ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                  ║
║  USSD: POST /ussd                             ║
║  Callback: POST /pesaflux-callback            ║
╠════════════════════════════════════════════════╣
║  ✨ NEW: Manual phone entry                   ║
║  ✨ NEW: All Kenyan formats supported         ║
║  ✨ NEW: Short messages (60 sec flow)         ║
╚════════════════════════════════════════════════╝
    `);
});
