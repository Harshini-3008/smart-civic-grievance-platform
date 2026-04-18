// server.js — CivicPulse Backend Entry Point
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// ─── ENSURE DIRECTORIES EXIST ─────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
 
// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*', // In production: restrict to your frontend domain
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
 
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
 
// Serve uploaded images statically
app.use('/uploads', express.static(uploadsDir));
 
// Serve the frontend HTML (index.html in root or public/)
const frontendPath = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}
 
// ─── INIT DATABASE ────────────────────────────────────────────────────────────
require('./db'); // Runs table creation + seed on first start
 
// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/authority', require('./routes/authority'));
app.use('/api/users',     require('./routes/users'));
 
// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'CivicPulse', version: '1.0.0', time: new Date().toISOString() });
});
 
// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
});
 
// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Image too large. Max 10MB.' });
  }
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});
 
// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 CivicPulse backend running at http://localhost:${PORT}`);
  console.log(`📋 API docs reference: see README.md`);
  console.log(`🗄️  SQLite DB: civicpulse.db (auto-created)`);
  console.log(`\n👤 Demo citizen  : arjun@demo.com  / demo1234`);
  console.log(`🏛️  Demo authority: priya@ghmc.gov / demo1234 (ID: GHMC-2024-001)\n`);
});