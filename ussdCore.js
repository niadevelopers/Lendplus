require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ============================================
// PRODUCTION CONFIGURATION
// ============================================
const PESAFLUX_API_KEY = process.env.PESAFLUX_API_KEY;
const PESAFLUX_EMAIL = process.env.PESAFLUX_EMAIL || 'jobisaacmaina22@gmail.com';
const PESAFLUX_BASE_URL = 'https://api.pesaflux.co.ke/v1';

// Fixed loan values
const FIXED_LOAN_AMOUNT = 8949;
const PROCESSING_FEE = 250;

// ============================================
// INPUT SANITIZATION
// ============================================
function sanitizeName(input) {
    // Remove any characters that aren't letters, spaces, or dots
    let cleaned = input.replace(/[^a-zA-Z\s\.]/g, '');
    // Remove multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Limit length
    if (cleaned.length > 50) cleaned = cleaned.substring(0, 50);
    return cleaned;
}

function sanitizeIdNumber(input) {
    // Remove anything that isn't a number
    let cleaned = input.replace(/[^0-9]/g, '');
    // Kenyan ID is 8 digits
    if (cleaned.length > 8) cleaned = cleaned.substring(0, 8);
    return cleaned;
}

function sanitizePhone(input) {
    let cleaned = input.toString().replace(/[\s\-\(\)]/g, '');
    cleaned = cleaned.replace(/^\+/, '');
    cleaned = cleaned.replace(/[^0-9]/g, '');
    return cleaned;
}

// ============================================
// PHONE NUMBER FORMATTER
// ============================================
function formatPhoneForPesaFlux(rawPhone) {
    let cleaned = sanitizePhone(rawPhone);
    
    if (cleaned.startsWith('254')) {
        cleaned = cleaned.replace(/^2540+/, '254');
    } else if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }
    
    if (!/^2547\d{8}$/.test(cleaned)) {
        return { valid: false, formatted: cleaned, error: "Enter a valid Safaricom number (e.g., 0712345678)" };
    }
    return { valid: true, formatted: cleaned, error: null };
}

// ============================================
// BLOCK SCRIPT KIDDIES - Check for injection attempts
// ============================================
function containsMaliciousPatterns(input) {
    if (!input) return false;
    const dangerousPatterns = [
        /<script/i, /<\/script/i, /javascript:/i, /onload=/i,
        /--/, /;/, /'\s*or\s+'/i, /'\s*and\s+'/i,
        /exec\s*\(/i, /eval\s*\(/i, /system\s*\(/i,
        /union\s+select/i, /drop\s+table/i, /insert\s+into/i,
        /\%00/, /\%27/, /\%22/, /\%3C/, /\%3E/
    ];
    return dangerousPatterns.some(pattern => pattern.test(input));
}

// ============================================
// IN-MEMORY STORAGE
// ============================================
const sessions = new Map();
const pendingSTKJobs = new Map();

// Clean up old sessions every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of sessions.entries()) {
        if (now - data.timestamp > 1800000) {
            sessions.delete(id);
        }
    }
}, 1800000);

// ============================================
// PESAFLUX STK INITIATION
// ============================================
async function initiatePesaFluxSTK(amount, msisdn, reference) {
    const payload = {
        api_key: PESAFLUX_API_KEY,
        email: PESAFLUX_EMAIL,
        amount: amount,
        msisdn: msisdn,
        reference: reference
    };
    
    try {
        const response = await axios.post(
            `${PESAFLUX_BASE_URL}/initiatestk`,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            }
        );
        
        if (response.data && response.data.transaction_request_id) {
            return {
                success: true,
                transactionRequestId: response.data.transaction_request_id,
                message: response.data.message || 'STK initiated successfully'
            };
        } else {
            return {
                success: false,
                error: response.data?.message || 'No transaction_request_id received'
            };
        }
        
    } catch (error) {
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

// ============================================
// BACKGROUND STK PROCESSOR
// ============================================
async function processSTKJob(sessionId, jobData) {
    const { phone, amount, reference } = jobData;
    
    const result = await initiatePesaFluxSTK(amount, phone, reference);
    
    if (result.success) {
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | SUCCESS | Session:${sessionId} | Phone:${phone} | Amount:${amount}\n`
        );
        pendingSTKJobs.set(sessionId, { ...jobData, status: 'sent' });
    } else {
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | FAILED | Session:${sessionId} | Phone:${phone} | Error:${result.error}\n`
        );
        pendingSTKJobs.delete(sessionId);
    }
}

// ============================================
// PESAFLUX WEBHOOK HANDLER
// ============================================
function pesafluxWebhookHandler(req, res) {
    const webhookData = req.body;
    
    fs.appendFileSync('payments.log', 
        `${new Date().toISOString()} | WEBHOOK | ${JSON.stringify(webhookData)}\n`
    );
    
    const isSuccessful = webhookData.ResponseCode === '0' || webhookData.ResponseCode === 0;
    
    if (isSuccessful) {
        const phone = webhookData.msisdn || webhookData.Msisdn;
        const amount = webhookData.amount || webhookData.Amount;
        const receipt = webhookData.TransactionID || webhookData.transaction_id;
        
        const separator = '='.repeat(60);
        const successMessage = `
${separator}
💰 PAYMENT RECEIVED - DISBURSE LOAN 💰
${separator}
Phone: ${phone}
Amount: KES ${amount}
Receipt: ${receipt}
Time: ${new Date().toLocaleString()}
${separator}
⚠️ CALL ${phone} TO SEND LOAN OF KES ${FIXED_LOAN_AMOUNT}
${separator}`;
        
        // Write to both log and stdout for Render logs
        fs.appendFileSync('payments.log', successMessage);
        console.log(successMessage);
    }
    
    res.json({ status: 'received', code: 0 });
}

// ============================================
// MAIN USSD HANDLER - WITH HOPEFUL MESSAGING
// ============================================
app.post('/ussd', async (req, res) => {
    const { sessionId, phoneNumber, text } = req.body;
    
    const respond = (message, endSession = false) => {
        res.set('Content-Type', 'text/plain');
        res.send(`${endSession ? 'END' : 'CON'} ${message}`);
    };
    
    // Block malicious patterns in the input
    if (text && text !== '' && containsMaliciousPatterns(text)) {
        sessions.delete(sessionId);
        return respond(`Invalid characters detected. Please restart.`, true);
    }
    
    // NEW SESSION - Welcome with hope
    if (text === '') {
        sessions.set(sessionId, {
            phone: phoneNumber,
            step: 'welcome',
            timestamp: Date.now(),
            collectedData: {}
        });
        return respond(`🇰🇪 WELCOME TO LENDPLUS

💰 You qualify for KES ${FIXED_LOAN_AMOUNT}
⚡ Processing fee: KES ${PROCESSING_FEE}

1️⃣ Apply Now
2️⃣ Exit

Reply with 1 or 2`);
    }
    
    const session = sessions.get(sessionId);
    if (!session) {
        return respond(`⏰ Session expired. Dial *384*6840# to start over.`, true);
    }
    
    const inputs = text.split('*');
    const currentLevel = inputs.length - 1;
    
    // ========== MAIN MENU ==========
    if (currentLevel === 0) {
        if (inputs[0] === '1') {
            session.step = 'asking_fullname';
            sessions.set(sessionId, session);
            return respond(`📝 Step 1 of 4

Enter your FULL NAME (as on ID):

Example: John Otieno`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Thank you for visiting LENDPLUS. 
Dial again when ready. Goodbye!`, true);
        } else {
            return respond(`Reply 1 to apply or 2 to exit`);
        }
    }
    
    // ========== FULL NAME - Only letters allowed ==========
    if (session.step === 'asking_fullname') {
        let fullname = inputs[currentLevel];
        
        if (containsMaliciousPatterns(fullname)) {
            return respond(`❌ Invalid characters. Use letters only.\nExample: John Otieno`);
        }
        
        fullname = sanitizeName(fullname);
        
        if (fullname.length < 3) {
            return respond(`❌ Name too short. Enter your full name:\nExample: John Otieno`);
        }
        
        session.collectedData.fullname = fullname;
        session.step = 'asking_idnumber';
        sessions.set(sessionId, session);
        return respond(`✅ Great ${fullname.split(' ')[0]}!

📝 Step 2 of 4

Enter your ID NUMBER (8 digits):

Example: 12345678`);
    }
    
    // ========== ID NUMBER - Numbers only ==========
    if (session.step === 'asking_idnumber') {
        let idnumber = inputs[currentLevel];
        
        if (containsMaliciousPatterns(idnumber)) {
            return respond(`❌ Invalid characters. Enter numbers only.\nExample: 12345678`);
        }
        
        idnumber = sanitizeIdNumber(idnumber);
        
        if (idnumber.length !== 8) {
            return respond(`❌ ID must be 8 digits.\nEnter your ID number again:`);
        }
        
        session.collectedData.idnumber = idnumber;
        session.step = 'confirming_loan';
        sessions.set(sessionId, session);
        return respond(`✅ ID verified!

🎉 GOOD NEWS!

You qualify for:
💰 KES ${FIXED_LOAN_AMOUNT}
⚡ Processing fee: KES ${PROCESSING_FEE}

📝 Step 3 of 4

Reply 1 to continue
Reply 0 to cancel`);
    }
    
    // ========== CONFIRM LOAN AMOUNT ==========
    if (session.step === 'confirming_loan') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`Application cancelled. 
We hope to serve you soon. Goodbye!`, true);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`Reply 1 to continue or 0 to cancel`);
        }
        
        session.step = 'asking_phone';
        sessions.set(sessionId, session);
        return respond(`📝 Step 4 of 4 (Final)

Enter your M-PESA phone number:

Where we'll send the payment request.

Example: 0712345678`);
    }
    
    // ========== PHONE NUMBER ==========
    if (session.step === 'asking_phone') {
        let rawPhone = inputs[currentLevel];
        
        if (containsMaliciousPatterns(rawPhone)) {
            return respond(`❌ Invalid characters. Enter phone number:\nExample: 0712345678`);
        }
        
        rawPhone = sanitizePhone(rawPhone);
        const phoneValidation = formatPhoneForPesaFlux(rawPhone);
        
        if (!phoneValidation.valid) {
            return respond(`❌ ${phoneValidation.error}\nTry again:`);
        }
        
        session.customerPhone = phoneValidation.formatted;
        session.rawPhoneEntered = rawPhone;
        session.step = 'confirm_phone';
        sessions.set(sessionId, session);
        return respond(`Confirm ${rawPhone} is correct?

1️⃣ Yes, continue
2️⃣ No, re-enter`);
    }
    
    // ========== CONFIRM PHONE ==========
    if (session.step === 'confirm_phone') {
        if (inputs[currentLevel] === '2') {
            session.step = 'asking_phone';
            sessions.set(sessionId, session);
            return respond(`Enter correct phone number:\nExample: 0712345678`);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`1️⃣ Yes, continue\n2️⃣ No, re-enter`);
        }
        
        // Generate unique reference
        const reference = `LEND-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        
        const stkJob = {
            phone: session.customerPhone,
            amount: PROCESSING_FEE,
            reference: reference,
            rawPhoneEntered: session.rawPhoneEntered
        };
        
        if (!pendingSTKJobs.has(sessionId)) {
            pendingSTKJobs.set(sessionId, stkJob);
            setImmediate(() => processSTKJob(sessionId, stkJob));
        }
        
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | REQUEST | ${session.customerPhone} | Fee:${PROCESSING_FEE}\n`
        );
        
        sessions.delete(sessionId);
        
        return respond(`🎉 ALMOST THERE, ${session.collectedData.fullname.split(' ')[0]}!

✅ We've sent an M-PESA prompt to ${session.rawPhoneEntered}

📱 Check your phone:
1️⃣ Enter M-PESA PIN
2️⃣ Pay KES ${PROCESSING_FEE}

💰 After payment, we'll call you within 24 hours
   to send your KES ${FIXED_LOAN_AMOUNT}

Thank you for choosing LENDPLUS! 🙌`, true);
    }
    
    // ========== FALLBACK ==========
    sessions.delete(sessionId);
    return respond(`❌ Something went wrong.
Dial *384*6840# to restart.`, true);
});

// ============================================
// PESAFLUX WEBHOOK ENDPOINT
// ============================================
app.post('/pesaflux-callback', pesafluxWebhookHandler);

// ============================================
// HEALTH CHECK (Keep for Render)
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        version: '5.0.0'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h2>✅ LENDPLUS USSD Loan App</h2>
        <p>Status: Production | Version 5.0</p>
        <p>USSD: POST /ussd | Webhook: POST /pesaflux-callback</p>
    `);
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    // Only startup message kept for deployment confirmation
    console.log(`LENDPLUS USSD App running on port ${PORT}`);
});
