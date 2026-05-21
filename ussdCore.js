require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Store active sessions (clears automatically after 1 hour)
const sessions = new Map();

// Clean up old sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of sessions.entries()) {
        if (now - data.timestamp > 3600000) {
            sessions.delete(id);
        }
    }
    console.log(`🧹 Session cleanup complete. Active sessions: ${sessions.size}`);
}, 3600000);

// Create payments log file if it doesn't exist
if (!fs.existsSync('payments.log')) {
    fs.writeFileSync('payments.log', '=== PAYMENTS LOG ===\n');
}

/* ============================================
   MAIN USSD HANDLER - PRODUCTION READY
   ============================================ */
app.post('/ussd', async (req, res) => {
    const { sessionId, phoneNumber, text } = req.body;
    
    console.log(`📱 USSD Request: ${sessionId} | ${phoneNumber} | Text: "${text}"`);
    
    // Helper function to send USSD response
    const respond = (message, endSession = false) => {
        res.set('Content-Type', 'text/plain');
        res.send(`${endSession ? 'END' : 'CON'} ${message}`);
    };
    
    // NEW SESSION - User just dialed the code
    if (text === '') {
        sessions.set(sessionId, {
            phone: phoneNumber,
            step: 'welcome',
            timestamp: Date.now()
        });
        
        return respond(`🌍 WELCOME TO [YOUR LOAN NAME]
        
Get instant loan up to KES 50,000

1. Apply for loan
2. Exit

Reply with 1 or 2`);
    }
    
    // Get user session
    const session = sessions.get(sessionId);
    if (!session) {
        return respond(`❌ Session expired. Please dial the code again to start over.`, true);
    }
    
    // Parse user input path (e.g., "1*2*1" = ['1','2','1'])
    const inputs = text.split('*');
    const currentLevel = inputs.length - 1;
    
    // ========== MAIN MENU (Level 0) ==========
    if (currentLevel === 0) {
        if (inputs[0] === '1') {
            session.step = 'asking_amount';
            sessions.set(sessionId, session);
            return respond(`💰 STEP 1 OF 4
        
Enter loan amount:
Minimum: KES 500
Maximum: KES 50,000

Example: 5000`);
        } else if (inputs[0] === '2') {
            sessions.delete(sessionId);
            return respond(`Thank you for your interest. Goodbye!`, true);
        } else {
            return respond(`Invalid option. Reply 1 to apply or 2 to exit.`);
        }
    }
    
    // ========== ASKING FOR AMOUNT (Level 1) ==========
    if (session.step === 'asking_amount') {
        const amount = parseInt(inputs[currentLevel]);
        
        if (isNaN(amount) || amount < 500 || amount > 50000) {
            return respond(`❌ Invalid amount.
            
Enter amount between KES 500 and KES 50,000
Example: 5000`);
        }
        
        session.loanAmount = amount;
        session.collateral = Math.floor(amount * 0.20);
        session.step = 'asking_purpose';
        sessions.set(sessionId, session);
        
        return respond(`📋 STEP 2 OF 4
        
Loan Amount: KES ${amount}
Collateral: KES ${session.collateral} (20%)

What will you use this loan for?
1. Business
2. School fees
3. Emergency
4. Other

Reply 1, 2, 3, or 4`);
    }
    
    // ========== ASKING FOR PURPOSE (Level 2) ==========
    if (session.step === 'asking_purpose') {
        let purpose = '';
        switch(inputs[currentLevel]) {
            case '1': purpose = 'Business'; break;
            case '2': purpose = 'School fees'; break;
            case '3': purpose = 'Emergency'; break;
            case '4': purpose = 'Other'; break;
            default: 
                return respond(`❌ Invalid. Reply 1, 2, 3, or 4 for loan purpose.`);
        }
        
        session.loanPurpose = purpose;
        session.step = 'showing_terms';
        sessions.set(sessionId, session);
        
        return respond(`⚖️ STEP 3 OF 4 - TERMS & CONDITIONS
        
Loan Amount: KES ${session.loanAmount}
Purpose: ${purpose}
Collateral: KES ${session.collateral}
Repayment: 30 days
Interest: 10% flat
Late fee: KES 50/day

Reply 1 to ACCEPT
Reply 0 to DECLINE`);
    }
    
    // ========== TERMS ACCEPTANCE (Level 3) ==========
    if (session.step === 'showing_terms') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`❌ Application cancelled.
            
Thank you for your interest.`, true);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`Reply 1 to ACCEPT terms or 0 to DECLINE`);
        }
        
        session.step = 'confirming_collateral';
        sessions.set(sessionId, session);
        
        return respond(`✅ STEP 4 OF 4 - FINAL STEP
        
You qualify for: KES ${session.loanAmount}

Pay collateral: KES ${session.collateral}

Reply 1 to pay via M-Pesa
Reply 0 to cancel`);
    }
    
    // ========== PAYMENT CONFIRMATION (Level 4) ==========
    if (session.step === 'confirming_collateral') {
        if (inputs[currentLevel] === '0') {
            sessions.delete(sessionId);
            return respond(`❌ Application cancelled.
            
Dial code again to restart.`, true);
        }
        
        if (inputs[currentLevel] !== '1') {
            return respond(`Reply 1 to pay or 0 to cancel`);
        }
        
        // ========== TRIGGER PESAFLUX STK PUSH ==========
        const orderRef = `LOAN-${sessionId}-${Date.now()}`;
        const callbackUrl = `${req.protocol}://${req.get('host')}/pesaflux-callback`;
        
        // Format phone number to 254XXXXXXXXX
        let formattedPhone = session.phone.replace(/^0+/, '').replace(/^\+/, '');
        if (!formattedPhone.startsWith('254')) {
            formattedPhone = '254' + formattedPhone;
        }
        
        try {
            console.log(`💳 Triggering STK Push for ${formattedPhone} - Amount: ${session.collateral}`);
            
            const pesafluxResponse = await axios.post(
                'https://pesaflux.com/api/stkpush',
                {
                    amount: session.collateral,
                    phone: formattedPhone,
                    order_ref: orderRef,
                    callback_url: callbackUrl
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.PESAFLUX_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            
            if (pesafluxResponse.data && pesafluxResponse.data.checkout_request_id) {
                // Store checkout ID for reference
                session.checkoutId = pesafluxResponse.data.checkout_request_id;
                session.orderRef = orderRef;
                session.step = 'payment_sent';
                sessions.set(sessionId, session);
                
                // Log payment initiation
                fs.appendFileSync('payments.log', 
                    `${new Date().toISOString()} | INITIATED | Phone: ${session.phone} | Amount: ${session.collateral} | CheckoutID: ${session.checkoutId}\n`
                );
                
                return respond(`💰 M-PESA PAYMENT INITIATED
        
STK Push sent to ${session.phone}

Please check your phone:
1. Enter M-PESA PIN
2. Complete payment of KES ${session.collateral}

✅ After payment, you will receive confirmation
📞 Our team will call you within 24 hours

Thank you for choosing us!`, true);
            } else {
                throw new Error('No checkout ID received');
            }
            
        } catch (error) {
            console.error('❌ PesaFlux Error:', error.response?.data || error.message);
            
            fs.appendFileSync('payments.log', 
                `${new Date().toISOString()} | FAILED | Phone: ${session.phone} | Error: ${error.message}\n`
            );
            
            return respond(`❌ PAYMENT INITIATION FAILED
        
Technical error occurred.
Please try again later.
Dial code again to restart.`, true);
        }
    }
    
    // ========== FALLBACK ==========
    return respond(`❌ Something went wrong.
    
Please dial the code again to restart.`, true);
});

/* ============================================
   PESAFLUX CALLBACK - RECEIVES PAYMENT CONFIRMATION
   ============================================ */
app.post('/pesaflux-callback', async (req, res) => {
    const callbackData = req.body;
    
    console.log(`\n🔔 PESAFLUX CALLBACK RECEIVED: ${new Date().toISOString()}`);
    console.log(JSON.stringify(callbackData, null, 2));
    
    // Log raw callback to file
    fs.appendFileSync('payments.log', 
        `${new Date().toISOString()} | CALLBACK | ${JSON.stringify(callbackData)}\n`
    );
    
    // Check if payment was successful
    let isSuccessful = false;
    let amount = null;
    let phone = null;
    let receipt = null;
    let checkoutId = null;
    
    // Handle different response formats from PesaFlux
    if (callbackData.status === 'success' || callbackData.ResultCode === '0') {
        isSuccessful = true;
        amount = callbackData.amount || callbackData.Amount;
        phone = callbackData.phone || callbackData.PhoneNumber;
        receipt = callbackData.mpesa_receipt_number || callbackData.MpesaReceiptNumber;
        checkoutId = callbackData.checkout_request_id || callbackData.CheckoutRequestID;
    }
    
    if (isSuccessful) {
        // Format the success message for console/terminal
        const separator = '='.repeat(60);
        const successMessage = `
${separator}
💰💰💰 PAYMENT RECEIVED - ACTION REQUIRED! 💰💰💰
${separator}
📱 Customer Phone: ${phone}
💰 Amount Paid: KES ${amount}
🧾 M-Pesa Receipt: ${receipt}
🆔 Checkout ID: ${checkoutId}
⏰ Time: ${new Date().toLocaleString()}
${separator}
⚠️  YOU MUST CALL THIS CUSTOMER TO DISBURSE LOAN ⚠️
📞 Phone: ${phone}
${separator}
`;
        
        console.log(successMessage);
        
        // Also write to log file with clear formatting
        fs.appendFileSync('payments.log', `
${separator}
SUCCESSFUL PAYMENT - ${new Date().toISOString()}
Phone: ${phone}
Amount: KES ${amount}
Receipt: ${receipt}
CheckoutID: ${checkoutId}
${separator}
`);
        
        // Optional: Play a beep sound in terminal (works on Mac/Linux)
        // process.stdout.write('\x07');
        
    } else {
        console.log(`❌ Payment failed or pending:`, callbackData);
        fs.appendFileSync('payments.log', 
            `${new Date().toISOString()} | FAILED_CALLBACK | ${JSON.stringify(callbackData)}\n`
        );
    }
    
    // Always respond with success to PesaFlux
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

/* ============================================
   HEALTH CHECK ENDPOINT
   ============================================ */
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        version: '1.0.0'
    });
});

/* ============================================
   ROOT ENDPOINT
   ============================================ */
app.get('/', (req, res) => {
    res.send(`
        <h2>✅ USSD Loan App is Running</h2>
        <p>Status: Production Ready</p>
        <p>Active Sessions: ${sessions.size}</p>
        <p>Time: ${new Date().toLocaleString()}</p>
        <hr>
        <p><b>USSD Endpoint:</b> POST /ussd</p>
        <p><b>Callback Endpoint:</b> POST /pesaflux-callback</p>
    `);
});

/* ============================================
   START SERVER
   ============================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║     ✅ USSD LOAN APP - PRODUCTION READY        ║
╠════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                ║
║  USSD Endpoint: POST /ussd                     ║
║  Callback URL: POST /pesaflux-callback         ║
╠════════════════════════════════════════════════╣
║  📱 Ready to accept USSD requests              ║
║  💰 PesaFlux integration active                ║
║  📝 Payments logged to payments.log            ║
╚════════════════════════════════════════════════╝
    `);
});
