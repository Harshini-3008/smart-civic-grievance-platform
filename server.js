// routes/reports.js — Report submission, listing, upvote, duplicate check
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─── FILE UPLOAD SETUP ────────────────────────────────────────────────────────

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `img-${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatReport(r, userId) {
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
    image_url:      r.image_path ? (r.image_path.startsWith('http') ? r.image_path : `/uploads/${r.image_path}`) : null,
    resolve_image:  r.resolve_image || null,
    status:         r.status,
    upvotes:        r.upvotes,
    user_upvoted:   userId ? !!db.prepare('SELECT 1 FROM upvotes WHERE report_id=? AND user_id=?').get(r.id, userId) : false,
    reject_reason:  r.reject_reason || null,
    created_at:     r.created_at,
    updated_at:     r.updated_at,
    activity:       getActivity(r.id),
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

// ─── GET ALL REPORTS (community feed) ────────────────────────────────────────

/**
 * GET /api/reports?category=&status=&lat=&lng=&radius=
 * Public: returns all reports. Citizen sees all; filtered by query params.
 */
router.get('/', requireAuth, (req, res) => {
  const { category, status, lat, lng } = req.query;
  let query = 'SELECT * FROM reports WHERE 1=1';
  const params = [];

  if (category) { query += ' AND category=?';    params.push(category); }
  if (status)   { query += ' AND status=?';      params.push(status); }

  query += ' ORDER BY upvotes DESC, created_at DESC';

  let rows = db.prepare(query).all(...params);

  // Optional proximity filter (within ~5km)
  if (lat && lng) {
    const LAT = parseFloat(lat), LNG = parseFloat(lng);
    rows = rows.filter(r => {
      if (!r.lat || !r.lng) return true;
      return Math.abs(r.lat - LAT) < 0.05 && Math.abs(r.lng - LNG) < 0.05;
    });
  }

  res.json({
    success: true,
    count: rows.length,
    reports: rows.map(r => formatReport(r, req.user.id)),
  });
});

// ─── GET MY REPORTS ───────────────────────────────────────────────────────────

/**
 * GET /api/reports/mine
 * Returns only the logged-in citizen's reports
 */
router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reports WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ success: true, reports: rows.map(r => formatReport(r, req.user.id)) });
});

// ─── GET SINGLE REPORT ────────────────────────────────────────────────────────

/**
 * GET /api/reports/:id
 */
router.get('/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Report not found' });
  res.json({ success: true, report: formatReport(r, req.user.id) });
});

// ─── CHECK DUPLICATE ─────────────────────────────────────────────────────────

/**
 * POST /api/reports/check-duplicate
 * Body: { category, lat, lng }
 * Returns existing report if same category near same location
 */
router.post('/check-duplicate', requireAuth, (req, res) => {
  const { category, lat, lng } = req.body;
  if (!category) return res.status(400).json({ success: false, message: 'category required' });

  const rows = db.prepare(`
    SELECT * FROM reports WHERE category=? AND status NOT IN ('resolved','rejected')
  `).all(category);

  const LAT = parseFloat(lat) || 0;
  const LNG = parseFloat(lng) || 0;

  const dup = rows.find(r =>
    r.lat && r.lng &&
    Math.abs(r.lat - LAT) < 0.01 &&
    Math.abs(r.lng - LNG) < 0.01
  );

  if (dup) {
    return res.json({ success: true, duplicate: true, report: formatReport(dup, req.user.id) });
  }
  res.json({ success: true, duplicate: false });
});

// ─── SUBMIT REPORT ────────────────────────────────────────────────────────────

/**
 * POST /api/reports
 * Multipart form: image (file), category, description, location, lat, lng
 */
router.post('/', requireAuth, upload.single('image'), (req, res) => {
  const { category, description, location, lat, lng } = req.body;

  if (!category || !description || !location) {
    return res.status(400).json({ success: false, message: 'category, description and location are required' });
  }

  const catLabels = {
    roads:       '🛣️ Roads & Potholes',
    water:       '💧 Water Supply / Leakage',
    electricity: '⚡ Street Light / Electricity',
    garbage:     '🗑️ Garbage / Waste',
    drainage:    '🌊 Drainage / Flooding',
    trees:       '🌳 Trees / Green Spaces',
    noise:       '🔊 Noise Pollution',
    other:       '🔧 Other',
  };

  const catWords = (catLabels[category] || category).split(' ').slice(1).join(' ');
  const title    = `${catWords} reported`;
  const id       = `CP-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
  const imgPath  = req.file ? req.file.filename : null;

  db.prepare(`
    INSERT INTO reports
      (id, user_id, title, category, category_label, description, location, lat, lng, image_path, status, upvotes)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0)
  `).run(
    id, req.user.id, title, category, catLabels[category] || category,
    description, location,
    parseFloat(lat) || null, parseFloat(lng) || null,
    imgPath
  );

  // Log activity
  db.prepare('INSERT INTO activity_log (report_id, actor_id, action) VALUES (?,?,?)').run(id, req.user.id, 'submitted');

  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  res.status(201).json({ success: true, message: 'Report submitted!', report: formatReport(report, req.user.id) });
});

// ─── UPVOTE / UN-UPVOTE ───────────────────────────────────────────────────────

/**
 * POST /api/reports/:id/upvote
 * Toggles upvote for the authenticated user
 */
router.post('/:id/upvote', requireAuth, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

  const existing = db.prepare('SELECT id FROM upvotes WHERE report_id=? AND user_id=?').get(req.params.id, req.user.id);

  if (existing) {
    // Remove upvote
    db.prepare('DELETE FROM upvotes WHERE report_id=? AND user_id=?').run(req.params.id, req.user.id);
    db.prepare('UPDATE reports SET upvotes = MAX(0, upvotes-1), updated_at=datetime("now") WHERE id=?').run(req.params.id);
    const updated = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
    return res.json({ success: true, action: 'removed', upvotes: updated.upvotes, user_upvoted: false });
  } else {
    // Add upvote
    db.prepare('INSERT INTO upvotes (report_id, user_id) VALUES (?,?)').run(req.params.id, req.user.id);
    db.prepare('UPDATE reports SET upvotes = upvotes+1, updated_at=datetime("now") WHERE id=?').run(req.params.id);

    // Log activity
    db.prepare('INSERT INTO activity_log (report_id, actor_id, action) VALUES (?,?,?)').run(req.params.id, req.user.id, 'upvoted');

    const updated = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
    return res.json({ success: true, action: 'added', upvotes: updated.upvotes, user_upvoted: true });
  }
});

module.exports = router;