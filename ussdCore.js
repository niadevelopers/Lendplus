require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ============================================
// PESAFLUX CORRECT CONFIGURATION
// ============================================
const PESAFLUX_API_KEY = process.env.PESAFLUX_API_KEY;
const PESAFLUX_EMAIL = process.env.PESAFLUX_EMAIL || 'jobisaacmaina22@gmail.com';
const PESAFLUX_BASE_URL = 'https://api.pesaflux.co.ke/v1';

// ============================================
// IN-MEMORY STORAGE
// ============================================
const sessions = new Map();
const pendingSTKJobs = new Map();

// ============================================
// PHONE NUMBER FORMATTER (Handles 0714..., 2547..., +2547..., 014...)
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
    
    // Must be 2547XXXXXXXX format (12 digits total)
    if (!/^2547\d{8}$/.test(cleaned)) {
        return { valid: false, formatted: cleaned, error: "Enter a valid Safaricom number (e.g., 0712345678 or 254712345678)" };
    }
    return { valid: true, formatted: cleaned, error: null };
}

// ============================================
// CORRECT PESAFLUX STK INITIATION
// ============================================
async function initiatePesaFluxSTK(amount, msisdn, reference) {
    const payload = {
        api_key: PESAFLUX_API_KEY,
        email: PESAFLUX_EMAIL,
        amount: amount,
        msisdn: msisdn,  // NOT 'phone' - 'msisdn' is correct
        reference: reference  // NOT 'order_ref' - 'reference' is correct
    };
    
    console.log(`[PesaFlux] Initiating STK:`, JSON.stringify(payload, null, 2));
    
    try {
        const response = await axios.post(
            `${PESAFLUX_BASE_URL}/initiatestk`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        );
        
        console.log(`[PesaFlux] Response:`, JSON.stringify(response.data, null, 2));
        
        // The response should contain transaction_request_id
        if (response.data && response.data.transaction_request_id) {
            return {
                success: true,
                transactionRequestId: response.data.transaction_request_id,
                message: response.data.message || 'STK initiated successfully'
            };
        } else {
            return {
                success: false,
                error: response.data?.message || 'No transaction_request_id received',
                rawResponse: response.data
            };
        }
        
    } catch (error) {
        console.error(`[PesaFlux] Error:`, error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.message,
            rawResponse: error.response?.data
        };
    }
}

// ============================================
// CHECK TRANSACTION STATUS (Optional - for polling)
// ============================================
async function checkPesaFluxTransactionStatus(transactionRequestId) {
    const payload = {
        api_key: PESAFLUX_API_KEY,
        email: PESAFLUX_EMAIL,
        transaction_request_id: transactionRequestId
    };
    
    try {
        const response = await axios.post(
            `${PESAFLUX_BASE_URL}/transactionstatus`,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            }
        );
        
        return response.data;
    } catch (error) {
        console.error(`[Status Check Error]:`, error.message);
        return { status: 'error', message: error.message };
    }
}

// ============================================
// BACKGROUND STK PROCESSOR (Using Correct API)
// ============================================
async function processSTKJob(sessionId, jobData) {
    const { phone, amount, reference, rawPhoneEntered } = jobData;
    
    console.log(`[STK] Processing job for session ${sessionId} | Phone: ${phone} | Amount: ${amount}`);
    
    const result = await initiatePesaFluxSTK(amount, phone, reference);
    
    if (result.success) {
        console.log(`[STK] SUCCESS for ${sessionId} | TransactionID: ${result.transactionRequestId}`);
        
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | STK_SENT | Session:${sessionId} | Phone:${phone} | Amount:${amount} | TransactionID:${result.transactionRequestId}\n`
        );
        
        // Store the transaction ID for potential status checks
        pendingSTKJobs.set(sessionId, {
            ...jobData,
            transactionRequestId: result.transactionRequestId,
            status: 'pending'
        });
        
    } else {
        console.error(`[STK] FAILED for ${sessionId}: ${result.error}`);
        
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | STK_FAILED | Session:${sessionId} | Phone:${phone} | Error:${result.error}\n`
        );
        
        pendingSTKJobs.delete(sessionId);
    }
}

// ============================================
// PESAFLUX WEBHOOK HANDLER (Correct endpoint)
// ============================================
function pesafluxWebhookHandler(req, res) {
    const webhookData = req.body;
    
    console.log(`\n🔔 PESAFLUX WEBHOOK RECEIVED: ${new Date().toISOString()}`);
    console.log(JSON.stringify(webhookData, null, 2));
    
    fs.appendFileSync('payments.log', 
        `${new Date().toISOString()} | WEBHOOK | ${JSON.stringify(webhookData)}\n`
    );
    
    // Standard PesaFlux webhook response codes
    // ResponseCode: 0 = Success, 1032 = Cancelled, 1037 = Unreachable, 1001 = Already in progress
    const isSuccessful = webhookData.ResponseCode === '0' || webhookData.ResponseCode === 0;
    
    if (isSuccessful) {
        const phone = webhookData.msisdn || webhookData.Msisdn;
        const amount = webhookData.amount || webhookData.Amount;
        const receipt = webhookData.TransactionID || webhookData.transaction_id;
        const transactionId = webhookData.transaction_request_id || webhookData.TransactionRequestID;
        
        const separator = '='.repeat(60);
        console.log(`
${separator}
💰💰💰 PAYMENT RECEIVED - ACTION REQUIRED! 💰💰💰
${separator}
📱 Phone: ${phone}
💰 Amount: KES ${amount}
🧾 Receipt: ${receipt}
🆔 TransactionID: ${transactionId}
⏰ Time: ${new Date().toLocaleString()}
${separator}
⚠️ CALL THIS CUSTOMER TO DISBURSE LOAN ⚠️
📞 ${phone}
${separator}`);
    } else {
        console.log(`❌ Payment failed or error:`, webhookData);
    }
    
    // Always acknowledge receipt to PesaFlux
    res.json({ status: 'received', code: 0 });
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
    
    if (currentLevel === 0) {
        if (inputs[0] === '1') {
            session.step = 'asking_fullname';
            sessions.set(sessionId, session);
            return respond(`Enter your FULL NAME (as on ID):`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Goodbye!`, true);
        }
        return respond(`1.Apply 2.Exit`);
    }
    
    if (session.step === 'asking_fullname') {
        session.collectedData.fullname = inputs[currentLevel];
        session.step = 'asking_idnumber';
        sessions.set(sessionId, session);
        return respond(`Enter your ID NUMBER:`);
    }
    
    if (session.step === 'asking_idnumber') {
        session.collectedData.idnumber = inputs[currentLevel];
        session.step = 'asking_amount';
        sessions.set(sessionId, session);
        return respond(`Enter loan amount (500-50,000):`);
    }
    
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
    
    if (session.step === 'asking_purpose') {
        const purposeMap = { '1':'Business', '2':'School fees', '3':'Emergency', '4':'Other' };
        if (!purposeMap[inputs[currentLevel]]) {
            return respond(`1.Business 2.School 3.Emergency 4.Other`);
        }
        session.collectedData.purpose = purposeMap[inputs[currentLevel]];
        session.step = 'asking_phone';
        sessions.set(sessionId, session);
        return respond(`Enter M-Pesa number for loan:\n(Format: 0712345678)`);
    }
    
    if (session.step === 'asking_phone') {
        const rawPhone = inputs[currentLevel];
        const phoneValidation = formatPhoneForPesaFlux(rawPhone);
        
        if (!phoneValidation.valid) {
            return respond(`Invalid. ${phoneValidation.error}\nTry again:`);
        }
        
        session.customerPhone = phoneValidation.formatted;
        session.rawPhoneEntered = rawPhone;
        session.step = 'confirm_phone';
        sessions.set(sessionId, session);
        return respond(`Confirm ${rawPhone} is correct?\n1.Yes 2.No`);
    }
    
    if (session.step === 'confirm_phone') {
        if (inputs[currentLevel] === '2') {
            session.step = 'asking_phone';
            sessions.set(sessionId, session);
            return respond(`Enter correct number (e.g., 0712345678):`);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`1.Yes 2.No`);
        }
        
        const reference = `LOAN-${sessionId.slice(-8)}-${Date.now()}`;
        
        const stkJob = {
            phone: session.customerPhone,
            amount: session.collateral,
            reference: reference,
            rawPhoneEntered: session.rawPhoneEntered,
            collectedData: session.collectedData
        };
        
        if (!pendingSTKJobs.has(sessionId)) {
            pendingSTKJobs.set(sessionId, stkJob);
            
            setImmediate(() => {
                processSTKJob(sessionId, stkJob);
            });
        }
        
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | REQUEST | Session:${sessionId} | Phone:${session.customerPhone} | Amount:${session.collateral}\n`
        );
        
        sessions.delete(sessionId);
        
        return respond(`✅ We'll send M-Pesa prompt to ${session.rawPhoneEntered}\nCheck your phone and enter PIN.\nThank you!`, true);
    }
    
    sessions.delete(sessionId);
    return respond(`Error. Dial code again.`, true);
});

// ============================================
// PESAFLUX WEBHOOK ENDPOINT
// ============================================
app.post('/pesaflux-callback', pesafluxWebhookHandler);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        pendingSTKJobs: pendingSTKJobs.size,
        version: '4.0.0'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h2>✅ USSD Loan App v4</h2>
        <p>Status: Running | Sessions: ${sessions.size}</p>
        <p>POST /ussd - USSD endpoint</p>
        <p>POST /pesaflux-callback - PesaFlux webhook</p>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║     ✅ USSD LOAN APP v4 - DEPLOYED             ║
╠════════════════════════════════════════════════╣
║  Port: ${PORT}                                  ║
║  USSD: POST /ussd                             ║
║  Webhook: POST /pesaflux-callback             ║
╠════════════════════════════════════════════════╣
║  🔧 CORRECT PesaFlux Integration:            ║
║  - URL: api.pesaflux.co.ke/v1/initiatestk    ║
║  - Fields: api_key, email, amount, msisdn    ║
║  - Webhook: /pesaflux-callback               ║
╚════════════════════════════════════════════════╝
    `);
});
