// routes/auth.js — Register, Login, OTP flow
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db       = require('../db');
const { generateToken } = require('../middleware/auth');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** In production: send real SMS/email. Here we store OTP and log it. */
function createOTP(identifier, purpose) {
  // For demo: always use 123456
  const otp     = '123456';
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // Invalidate any existing OTPs for this identifier
  db.prepare(`UPDATE otp_store SET used=1 WHERE identifier=? AND purpose=? AND used=0`)
    .run(identifier, purpose);

  db.prepare(`INSERT INTO otp_store (identifier, otp, purpose, expires_at) VALUES (?,?,?,?)`)
    .run(identifier, otp, purpose, expires);

  console.log(`📱 OTP for ${identifier} [${purpose}]: ${otp}  (demo — always 123456)`);
  return otp;
}

function verifyOTP(identifier, otp, purpose) {
  const record = db.prepare(`
    SELECT * FROM otp_store
    WHERE identifier=? AND otp=? AND purpose=? AND used=0 AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(identifier, otp, purpose);

  if (!record) return false;
  db.prepare(`UPDATE otp_store SET used=1 WHERE id=?`).run(record.id);
  return true;
}

// ─── CITIZEN REGISTER ────────────────────────────────────────────────────────

/**
 * POST /api/auth/register/send-otp
 * Body: { first_name, last_name, email, phone, password }
 */
router.post('/register/send-otp', (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;

  if (!first_name || !email || !password) {
    return res.status(400).json({ success: false, message: 'first_name, email and password are required' });
  }

  // Check duplicate email
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already registered. Please login.' });
  }

  // Store pending registration in OTP store (identifier = email, purpose = register)
  // We store the hashed password and name temporarily encoded in the OTP note
  // For simplicity: we store in a temp column; real app uses Redis/session
  createOTP(email, 'register');

  res.json({ success: true, message: 'OTP sent to your email/phone. Use 123456 for demo.' });
});

/**
 * POST /api/auth/register/verify-otp
 * Body: { first_name, last_name, email, phone, password, otp }
 */
router.post('/register/verify-otp', (req, res) => {
  const { first_name, last_name, email, phone, password, otp } = req.body;

  if (!verifyOTP(email, otp, 'register')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  // Double-check no duplicate
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already registered' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const id = 'usr-' + uuid();

  db.prepare(`
    INSERT INTO users (id, first_name, last_name, email, phone, password, role)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, first_name, last_name || '', email, phone || '', hashed, 'citizen');

  const user  = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const token = generateToken(user);

  res.json({
    success: true,
    message: 'Registration successful!',
    token,
    user: sanitizeUser(user),
  });
});

// ─── AUTHORITY REGISTER ───────────────────────────────────────────────────────

/**
 * POST /api/auth/authority/register/send-otp
 * Body: { first_name, last_name, email, phone, password, dept, auth_id }
 */
router.post('/authority/register/send-otp', (req, res) => {
  const { first_name, email, password, dept, auth_id } = req.body;

  if (!first_name || !email || !password || !dept || !auth_id) {
    return res.status(400).json({ success: false, message: 'All authority fields are required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email=? OR auth_id=?').get(email, auth_id);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email or Authority ID already registered' });
  }

  createOTP(email, 'register');
  res.json({ success: true, message: 'OTP sent. Use 123456 for demo.' });
});

/**
 * POST /api/auth/authority/register/verify-otp
 * Body: { first_name, last_name, email, phone, password, dept, auth_id, otp }
 */
router.post('/authority/register/verify-otp', (req, res) => {
  const { first_name, last_name, email, phone, password, dept, auth_id, otp } = req.body;

  if (!verifyOTP(email, otp, 'register')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email=? OR auth_id=?').get(email, auth_id);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Already registered' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const id     = 'auth-' + uuid();

  db.prepare(`
    INSERT INTO users (id, first_name, last_name, email, phone, password, role, dept, auth_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, first_name, last_name || '', email, phone || '', hashed, 'authority', dept, auth_id);

  const user  = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const token = generateToken(user);

  res.json({ success: true, message: 'Authority account created!', token, user: sanitizeUser(user) });
});

// ─── CITIZEN LOGIN ────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login/send-otp
 * Body: { email, password }
 */
router.post('/login/send-otp', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='citizen'").get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  createOTP(email, 'login');
  res.json({ success: true, message: 'OTP sent. Use 123456 for demo.' });
});

/**
 * POST /api/auth/login/verify-otp
 * Body: { email, otp }
 */
router.post('/login/verify-otp', (req, res) => {
  const { email, otp } = req.body;

  if (!verifyOTP(email, otp, 'login')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='citizen'").get(email);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const token = generateToken(user);
  res.json({ success: true, token, user: sanitizeUser(user) });
});

// ─── AUTHORITY LOGIN ──────────────────────────────────────────────────────────

/**
 * POST /api/auth/authority/login/send-otp
 * Body: { email, password, auth_id, dept }
 */
router.post('/authority/login/send-otp', (req, res) => {
  const { email, password, auth_id } = req.body;
  if (!email || !password || !auth_id) {
    return res.status(400).json({ success: false, message: 'Email, password and authority ID required' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='authority' AND auth_id=?").get(email, auth_id);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials or Authority ID' });
  }

  createOTP(email, 'login');
  res.json({ success: true, message: 'OTP sent. Use 123456 for demo.' });
});

/**
 * POST /api/auth/authority/login/verify-otp
 * Body: { email, otp }
 */
router.post('/authority/login/verify-otp', (req, res) => {
  const { email, otp } = req.body;

  if (!verifyOTP(email, otp, 'login')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='authority'").get(email);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const token = generateToken(user);
  res.json({ success: true, token, user: sanitizeUser(user) });
});

// ─── HELPER ───────────────────────────────────────────────────────────────────

function sanitizeUser(u) {
  return {
    id:         u.id,
    first_name: u.first_name,
    last_name:  u.last_name,
    email:      u.email,
    phone:      u.phone,
    role:       u.role,
    dept:       u.dept    || null,
    auth_id:    u.auth_id || null,
  };
}

module.exports = router;