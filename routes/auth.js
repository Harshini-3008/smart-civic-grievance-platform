// Register, login, and OTP flow
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
    WHERE identifier=? AND otp=? AND purpose=? AND used=0 AND datetime(expires_at) > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(identifier, otp, purpose);

  if (!record) return false;
  db.prepare(`UPDATE otp_store SET used=1 WHERE id=?`).run(record.id);
  return true;
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateRegistration({ first_name, email, password, dept, auth_id }, isAuthority) {
  if (typeof first_name !== 'string' || !first_name.trim() || first_name.trim().length > 80) {
    return 'A first name of at most 80 characters is required';
  }
  if (!validEmail(email)) return 'A valid email address is required';
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return 'Password must be between 8 and 128 characters';
  }
  if (isAuthority && (typeof dept !== 'string' || !dept.trim() ||
      typeof auth_id !== 'string' || !auth_id.trim() || auth_id.trim().length > 80)) {
    return 'A department and authority ID are required';
  }
  return null;
}

function beginRegistration({ first_name, last_name, email, phone, password, dept, auth_id }, role) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedAuthId = role === 'authority' ? auth_id.trim() : null;
  const passwordHash = bcrypt.hashSync(password, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const saveRegistration = db.transaction(() => {
    db.prepare("DELETE FROM pending_registrations WHERE datetime(expires_at) <= datetime('now')").run();
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail);
    if (existing) return 'Email already registered. Please login.';

    if (normalizedAuthId) {
      const authorityExists = db.prepare('SELECT id FROM users WHERE auth_id=?').get(normalizedAuthId);
      const registrationExists = db.prepare(
        'SELECT email FROM pending_registrations WHERE auth_id=? AND email<>?'
      ).get(normalizedAuthId, normalizedEmail);
      if (authorityExists || registrationExists) return 'Authority ID already registered';
    }

    db.prepare(`
      INSERT INTO pending_registrations
        (email, first_name, last_name, phone, password_hash, role, dept, auth_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        first_name=excluded.first_name,
        last_name=excluded.last_name,
        phone=excluded.phone,
        password_hash=excluded.password_hash,
        role=excluded.role,
        dept=excluded.dept,
        auth_id=excluded.auth_id,
        expires_at=excluded.expires_at
    `).run(
      normalizedEmail,
      first_name.trim(),
      typeof last_name === 'string' ? last_name.trim().slice(0, 80) : '',
      typeof phone === 'string' ? phone.trim().slice(0, 40) : '',
      passwordHash,
      role,
      role === 'authority' ? dept.trim().slice(0, 120) : null,
      normalizedAuthId,
      expiresAt
    );

    createOTP(normalizedEmail, 'register');
    return null;
  });

  return saveRegistration();
}

function completeRegistration(email, otp, role) {
  const complete = db.transaction(() => {
    const normalizedEmail = normalizeEmail(email);
    const record = db.prepare(`
      SELECT id FROM otp_store
      WHERE identifier=? AND otp=? AND purpose='register' AND used=0
        AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).get(normalizedEmail, otp);
    if (!record) return { error: 'Invalid or expired OTP' };

    const registration = db.prepare(`
      SELECT * FROM pending_registrations
      WHERE email=? AND role=? AND datetime(expires_at) > datetime('now')
    `).get(normalizedEmail, role);
    if (!registration) return { error: 'Registration expired. Please register again.' };

    const duplicate = db.prepare('SELECT id FROM users WHERE email=? OR (? IS NOT NULL AND auth_id=?)')
      .get(registration.email, registration.auth_id, registration.auth_id);
    if (duplicate) return { error: 'Email or Authority ID already registered' };

    const id = `${role === 'authority' ? 'auth' : 'usr'}-${uuid()}`;
    db.prepare(`
      INSERT INTO users (id, first_name, last_name, email, phone, password, role, dept, auth_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      registration.first_name,
      registration.last_name,
      registration.email,
      registration.phone,
      registration.password_hash,
      registration.role,
      registration.dept,
      registration.auth_id
    );
    db.prepare('UPDATE otp_store SET used=1 WHERE id=?').run(record.id);
    db.prepare('DELETE FROM pending_registrations WHERE email=?').run(registration.email);
    return { user: db.prepare('SELECT * FROM users WHERE id=?').get(id) };
  });

  return complete();
}

// ─── CITIZEN REGISTER ────────────────────────────────────────────────────────

/**
 * POST /api/auth/register/send-otp
 * Body: { first_name, last_name, email, phone, password }
 */
router.post('/register/send-otp', (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const validationError = validateRegistration({ first_name, email: normalizedEmail, password }, false);
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  const error = beginRegistration(
    { first_name, last_name, email: normalizedEmail, phone, password },
    'citizen'
  );
  if (error) return res.status(409).json({ success: false, message: error });

  res.json({ success: true, message: 'Registration saved. Use 123456 to verify your email.' });
});

/**
 * POST /api/auth/register/verify-otp
 * Body: { first_name, last_name, email, phone, password, otp }
 */
router.post('/register/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const result = completeRegistration(email, otp, 'citizen');
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  const token = generateToken(result.user);

  res.json({
    success: true,
    message: 'Registration successful!',
    token,
    user: sanitizeUser(result.user),
  });
});

// ─── AUTHORITY REGISTER ───────────────────────────────────────────────────────

/**
 * POST /api/auth/authority/register/send-otp
 * Body: { first_name, last_name, email, phone, password, dept, auth_id }
 */
router.post('/authority/register/send-otp', (req, res) => {
  const { first_name, last_name, email, phone, password, dept, auth_id } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const validationError = validateRegistration(
    { first_name, email: normalizedEmail, password, dept, auth_id },
    true
  );
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  const error = beginRegistration(
    { first_name, last_name, email: normalizedEmail, phone, password, dept, auth_id },
    'authority'
  );
  if (error) return res.status(409).json({ success: false, message: error });
  res.json({ success: true, message: 'Registration saved. Use 123456 to verify your email.' });
});

/**
 * POST /api/auth/authority/register/verify-otp
 * Body: { first_name, last_name, email, phone, password, dept, auth_id, otp }
 */
router.post('/authority/register/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const result = completeRegistration(email, otp, 'authority');
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  const token = generateToken(result.user);

  res.json({ success: true, message: 'Authority account created!', token, user: sanitizeUser(result.user) });
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

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='citizen'").get(normalizeEmail(email));
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
  const normalizedEmail = normalizeEmail(email);

  if (!verifyOTP(normalizedEmail, otp, 'login')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='citizen'").get(normalizedEmail);
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
  const { email, password, auth_id, dept } = req.body;
  if (!email || !password || !auth_id || !dept) {
    return res.status(400).json({ success: false, message: 'Email, password, authority ID and department required' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='authority' AND auth_id=? AND dept=?")
    .get(normalizeEmail(email), auth_id.trim(), dept.trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials or Authority ID' });
  }

  createOTP(normalizeEmail(email), 'login');
  res.json({ success: true, message: 'OTP sent. Use 123456 for demo.' });
});

/**
 * POST /api/auth/authority/login/verify-otp
 * Body: { email, otp }
 */
router.post('/authority/login/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!verifyOTP(normalizedEmail, otp, 'login')) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  const user = db.prepare("SELECT * FROM users WHERE email=? AND role='authority'").get(normalizedEmail);
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