// routes/authority.js — Authority dashboard: view, accept, reject, resolve
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');
const db       = require('../db');
const { requireAuthority } = require('../middleware/auth');

// ─── UPLOAD SETUP (resolution images) ────────────────────────────────────────

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `resolve-${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatReport(r) {
  return {
    id:             r.id,
    user_id:        r.user_id,
    title:          r.title,
    category:       r.category,
    category_label: r.category_label,
    description:    r.description,
    location:       r.location,
    lat:            r.lat,
    lng:            r.lng,
    image_url:      r.image_path
      ? (r.image_path.startsWith('http') ? r.image_path : `/uploads/${r.image_path}`)
      : null,
    resolve_image_url: r.resolve_image
      ? (r.resolve_image.startsWith('http') ? r.resolve_image : `/uploads/${r.resolve_image}`)
      : null,
    status:         r.status,
    upvotes:        r.upvotes,
    reject_reason:  r.reject_reason || null,
    created_at:     r.created_at,
    updated_at:     r.updated_at,
    activity:       getActivity(r.id),
    reporter:       getReporter(r.user_id),
  };
}

function getActivity(reportId) {
  return db.prepare(`
    SELECT a.action, a.note, a.created_at,
           u.first_name || ' ' || u.last_name AS actor_name, u.role AS actor_role
    FROM activity_log a
    JOIN users u ON u.id = a.actor_id
    WHERE a.report_id = ?
    ORDER BY a.created_at ASC
  `).all(reportId);
}

function getReporter(userId) {
  const u = db.prepare('SELECT first_name, last_name, email, phone FROM users WHERE id=?').get(userId);
  if (!u) return null;
  return { name: `${u.first_name} ${u.last_name}`.trim(), email: u.email, phone: u.phone };
}

// ─── GET ALL COMPLAINTS (dashboard) ──────────────────────────────────────────

/**
 * GET /api/authority/complaints?status=&category=
 * Returns all complaints visible to this authority (all in demo; real app: filter by dept/area)
 */
router.get('/complaints', requireAuthority, (req, res) => {
  const { status, category } = req.query;
  let query  = 'SELECT * FROM reports WHERE 1=1';
  const params = [];

  if (status)   { query += ' AND status=?';   params.push(status); }
  if (category) { query += ' AND category=?'; params.push(category); }

  query += ' ORDER BY upvotes DESC, created_at DESC';

  const rows = db.prepare(query).all(...params);

  // Stats
  const total    = db.prepare("SELECT COUNT(*) AS n FROM reports").get().n;
  const pending  = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='pending'").get().n;
  const accepted = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='accepted'").get().n;
  const resolved = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='resolved'").get().n;
  const rejected = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='rejected'").get().n;

  res.json({
    success: true,
    stats: { total, pending, accepted, resolved, rejected },
    count:  rows.length,
    complaints: rows.map(formatReport),
  });
});

// ─── GET SINGLE COMPLAINT ─────────────────────────────────────────────────────

/**
 * GET /api/authority/complaints/:id
 */
router.get('/complaints/:id', requireAuthority, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Complaint not found' });
  res.json({ success: true, complaint: formatReport(r) });
});

// ─── ACCEPT COMPLAINT ─────────────────────────────────────────────────────────

/**
 * PATCH /api/authority/complaints/:id/accept
 * Changes status: pending → accepted
 */
router.patch('/complaints/:id/accept', requireAuthority, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Report not found' });
  if (r.status !== 'pending') {
    return res.status(400).json({ success: false, message: `Cannot accept a report with status: ${r.status}` });
  }

  db.prepare(`UPDATE reports SET status='accepted', updated_at=datetime('now') WHERE id=?`).run(r.id);
  db.prepare('INSERT INTO activity_log (report_id, actor_id, action) VALUES (?,?,?)').run(r.id, req.user.id, 'accepted');

  const updated = db.prepare('SELECT * FROM reports WHERE id=?').get(r.id);
  res.json({ success: true, message: 'Complaint accepted', complaint: formatReport(updated) });
});

// ─── REJECT COMPLAINT ─────────────────────────────────────────────────────────

/**
 * PATCH /api/authority/complaints/:id/reject
 * Body: { reason }
 * Changes status: pending|accepted → rejected
 */
router.patch('/complaints/:id/reject', requireAuthority, (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A rejection reason is required' });
  }

  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Report not found' });
  if (r.status === 'resolved') {
    return res.status(400).json({ success: false, message: 'Cannot reject an already resolved complaint' });
  }

  db.prepare(`
    UPDATE reports SET status='rejected', reject_reason=?, updated_at=datetime('now') WHERE id=?
  `).run(reason.trim(), r.id);
  db.prepare('INSERT INTO activity_log (report_id, actor_id, action, note) VALUES (?,?,?,?)').run(r.id, req.user.id, 'rejected', reason.trim());

  const updated = db.prepare('SELECT * FROM reports WHERE id=?').get(r.id);
  res.json({ success: true, message: 'Complaint rejected', complaint: formatReport(updated) });
});

// ─── MARK AS RESOLVED (with image proof) ────────────────────────────────────

/**
 * PATCH /api/authority/complaints/:id/resolve
 * Multipart: resolve_image (file) — REQUIRED
 * Status must be 'accepted' before resolving
 */
router.patch('/complaints/:id/resolve', requireAuthority, upload.single('resolve_image'), (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Report not found' });

  if (r.status !== 'accepted') {
    return res.status(400).json({
      success: false,
      message: `Report must be in "accepted" state before resolving. Current status: ${r.status}`,
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'A resolution proof image is required to mark as resolved',
    });
  }

  const resolveImg = req.file.filename;

  db.prepare(`
    UPDATE reports SET status='resolved', resolve_image=?, updated_at=datetime('now') WHERE id=?
  `).run(resolveImg, r.id);
  db.prepare('INSERT INTO activity_log (report_id, actor_id, action, note) VALUES (?,?,?,?)').run(r.id, req.user.id, 'resolved', 'Resolution proof uploaded');

  const updated = db.prepare('SELECT * FROM reports WHERE id=?').get(r.id);
  res.json({ success: true, message: 'Complaint marked as resolved!', complaint: formatReport(updated) });
});

// ─── DASHBOARD STATS ─────────────────────────────────────────────────────────

/**
 * GET /api/authority/stats
 */
router.get('/stats', requireAuthority, (req, res) => {
  const stats = {
    total:    db.prepare("SELECT COUNT(*) AS n FROM reports").get().n,
    pending:  db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='pending'").get().n,
    accepted: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='accepted'").get().n,
    resolved: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='resolved'").get().n,
    rejected: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='rejected'").get().n,
    by_category: db.prepare(`
      SELECT category, category_label, COUNT(*) AS count
      FROM reports GROUP BY category ORDER BY count DESC
    `).all(),
    top_upvoted: db.prepare(`
      SELECT id, title, location, upvotes, status FROM reports
      ORDER BY upvotes DESC LIMIT 5
    `).all(),
  };
  res.json({ success: true, stats });
});

module.exports = router;