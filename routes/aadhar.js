require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const crypto = require('crypto');
const Twilio = require('twilio');

const router = express.Router();
const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// Upload folder
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 } });

// Shared session map
const otpSessions = new Map();

// Extract Aadhaar (dummy regex for digits)
function extractAadhaarFromText(text) {
  const match = text.match(/\b\d{4}\s\d{4}\s\d{4}\b/);
  return match ? match[0] : "Not detected";
}
function extractNameFromText(text) {
  const lines = text.split('\n').map(l => l.trim());
  for (const line of lines) {
    if (/^[A-Z\s]+$/.test(line) && !/\d/.test(line)) return line;
  }
  return "Not detected";
}

// Step 1: Upload Aadhaar + OCR + Send OTP
router.post('/verify-aadhaar', upload.any(), async (req, res) => {
  try {
    const file = req.files?.[0];
    const phone = req.body.phone; // user-entered phone
    if (!file) return res.status(400).json({ error: 'Missing Aadhaar image' });
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const imagePath = file.path;
    const result = await Tesseract.recognize(imagePath, 'eng');
    fs.unlinkSync(imagePath);

    const aadhaarNumber = extractAadhaarFromText(result.data.text);
    const name = extractNameFromText(result.data.text);

    const otp = (Math.floor(100000 + Math.random() * 900000)).toString();
    const sessionId = crypto.randomBytes(16).toString('hex');

    otpSessions.set(sessionId, { aadhaarNumber, name, otp, expiresAt: Date.now() + 5 * 60 * 1000 });

    let smsFailed = false;
    try {
      await client.messages.create({
        body: `Your OTP for Aadhaar verification is: ${otp}`,
        from: process.env.TWILIO_SENDER,
        to: phone,
      });
    } catch (err) {
      console.error("Failed SMS:", err.message);
      smsFailed = true;
    }

    res.json({
      success: true,
      message: smsFailed ? `Aadhaar matched. OTP sent (fallback shown)` : 'Aadhaar matched. OTP sent',
      sessionId,
      fallbackOtp: smsFailed ? otp : undefined
    });

  } catch (err) {
    console.error("AADHAAR VERIFY ERROR:", err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// Step 2: Confirm OTP
router.post('/confirm-otp', (req, res) => {
  const { sessionId, otp } = req.body;
  const session = otpSessions.get(sessionId);

  if (!session) return res.status(400).json({ error: 'invalid_session' });
  if (Date.now() > session.expiresAt) {
    otpSessions.delete(sessionId);
    return res.status(400).json({ error: 'expired' });
  }
  if (session.otp !== otp) return res.status(400).json({ error: 'invalid_otp' });

  otpSessions.delete(sessionId);
  res.json({
    success: true,
    message: 'Verification successful',
    data: { number: session.aadhaarNumber, name: session.name }
  });
});

module.exports = router;
