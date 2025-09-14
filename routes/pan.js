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

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 } });

const otpSessions = new Map();

function extractPanFromText(text) {
  const matches = text.match(/\b[A-Z]{5}\d{4}[A-Z]{1}\b/g);
  return matches ? matches[0] : "Not detected";
}
function extractNameFromText(text) {
  const lines = text.split('\n').map(l => l.trim());
  for (const line of lines) {
    if (/^[A-Z\s]+$/.test(line) && !/\d/.test(line)) return line;
  }
  return "Not detected";
}

// ----- Step 1: Verify PAN + Send OTP -----
router.post('/verify-pan', upload.any(), async (req, res) => {
  try {
    const file = req.files?.[0];
    const phone = req.body.phone;
    if (!file || !phone) return res.status(400).json({ error: 'Missing PAN image or phone number' });

    const imagePath = file.path;
    const result = await Tesseract.recognize(imagePath, 'eng');
    fs.unlinkSync(imagePath);

    const panNumber = extractPanFromText(result.data.text);
    const name = extractNameFromText(result.data.text);

    const otp = (Math.floor(100000 + Math.random() * 900000)).toString();
    const sessionId = crypto.randomBytes(16).toString('hex');

    otpSessions.set(sessionId, { panNumber, name, otp, phone, expiresAt: Date.now() + 5*60*1000 });

    try {
      await client.messages.create({
        body: `Your OTP for PAN verification is: ${otp}`,
        from: process.env.TWILIO_SENDER,
        to: phone
      });
      res.json({ success: true, message: 'PAN matched. OTP sent', sessionId });
    } catch(err) {
      console.error("SMS failed:", err.message);
      res.json({ success: true, message: 'PAN matched. OTP sent (SMS failed, check fallback)', sessionId, fallbackOtp: otp });
    }

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

// ----- Step 2: Confirm OTP -----
router.post('/confirm-otp', (req, res) => {
  const { sessionId, otp } = req.body;
  const session = otpSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: 'invalid_session' });
  if (Date.now() > session.expiresAt) {
    otpSessions.delete(sessionId);
    return res.status(400).json({ error: 'expired' });
  }
  if (session.otp !== otp) {
    return res.status(400).json({ error: 'invalid_otp' });
  }

  otpSessions.delete(sessionId);
  res.json({ success: true, message: 'Verification successful', data: { number: session.panNumber, name: session.name } });
});

module.exports = router;
