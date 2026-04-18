// db.js — SQLite database initialization using better-sqlite3
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'civicpulse.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── CREATE TABLES ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    phone       TEXT,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'citizen',   -- 'citizen' | 'authority'
    dept        TEXT,                               -- authority only
    auth_id     TEXT,                               -- authority employee ID
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS otp_store (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier  TEXT NOT NULL,   -- email or phone
    otp         TEXT NOT NULL,
    purpose     TEXT NOT NULL,   -- 'login' | 'register'
    expires_at  TEXT NOT NULL,
    used        INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reports (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    title          TEXT NOT NULL,
    category       TEXT NOT NULL,
    category_label TEXT NOT NULL,
    description    TEXT NOT NULL,
    location       TEXT NOT NULL,
    lat            REAL,
    lng            REAL,
    image_path     TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|resolved|rejected
    upvotes        INTEGER DEFAULT 0,
    resolve_image  TEXT,
    reject_reason  TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS upvotes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(report_id, user_id),
    FOREIGN KEY (report_id) REFERENCES reports(id),
    FOREIGN KEY (user_id)   REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    action     TEXT NOT NULL,   -- 'submitted'|'accepted'|'resolved'|'rejected'|'upvoted'
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id)
  );
`);

// ─── SEED DEMO DATA ──────────────────────────────────────────────────────────

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count > 0) return; // Already seeded

  const hash = bcrypt.hashSync('demo1234', 10);

  // Demo citizen
  db.prepare(`
    INSERT INTO users (id, first_name, last_name, email, phone, password, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('user-demo-001', 'Arjun', 'Sharma', 'arjun@demo.com', '+919876543210', hash, 'citizen');

  // Demo authority
  db.prepare(`
    INSERT INTO users (id, first_name, last_name, email, phone, password, role, dept, auth_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('auth-demo-001', 'Priya', 'Reddy', 'priya@ghmc.gov', '+919800001111', hash, 'authority', 'Roads & Infrastructure', 'GHMC-2024-001');

  // Demo reports
  const now = new Date().toISOString().split('T')[0];

  const insertReport = db.prepare(`
    INSERT INTO reports (id, user_id, title, category, category_label, description,
      location, lat, lng, image_path, status, upvotes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReport.run(
    'CP-2024-001', 'user-demo-001',
    'Large pothole on Main Road',
    'roads', '🛣️ Roads & Potholes',
    'There is a large pothole near the bus stop on Main Road. It has caused two accidents in the past week.',
    'Main Road, Near Bus Stop, Patancheru',
    17.5326, 78.2637,
    'https://www.prwlaw.com/wp-content/uploads/2022/09/How-do-potholes-cause-accidents.jpg',
    'accepted', 14, '2024-01-15', '2024-01-16'
  );

  insertReport.run(
    'CP-2024-002', 'user-demo-001',
    'Street light not working for 3 days',
    'electricity', '⚡ Street Light / Electricity',
    'The street light at the corner of Station Road has been off for 3 days making the area unsafe at night.',
    'Station Road, Miyapur, Hyderabad',
    17.4955, 78.3562,
    'https://images.unsplash.com/photo-1476136236990-838240be4859?w=600&q=80',
    'resolved', 8, '2024-01-10', '2024-01-12'
  );

  insertReport.run(
    'CP-2024-003', 'user-demo-001',
    'Garbage overflow near community park',
    'garbage', '🗑️ Garbage / Waste',
    'Garbage bins are overflowing near the community park. Strong smell and unhygienic conditions.',
    'Community Park, Kondapur, Hyderabad',
    17.4633, 78.3674,
    'https://images.unsplash.com/photo-1611270629569-8b357cb88da9?w=600&q=80',
    'pending', 22, '2024-01-18', '2024-01-18'
  );

  // Seed upvote counts in upvotes table
  const insertUp = db.prepare(`INSERT INTO upvotes (report_id, user_id) VALUES (?, ?)`);
  // Simulate multiple upvoters for demo reports
  ['auth-demo-001'].forEach(uid => {
    try { insertUp.run('CP-2024-001', uid); } catch(_){}
    try { insertUp.run('CP-2024-003', uid); } catch(_){}
  });

  // Activity log entries
  const insertLog = db.prepare(`INSERT INTO activity_log (report_id, actor_id, action, note) VALUES (?,?,?,?)`);
  insertLog.run('CP-2024-001', 'user-demo-001', 'submitted', null);
  insertLog.run('CP-2024-001', 'auth-demo-001', 'accepted', null);
  insertLog.run('CP-2024-002', 'user-demo-001', 'submitted', null);
  insertLog.run('CP-2024-002', 'auth-demo-001', 'accepted', null);
  insertLog.run('CP-2024-002', 'auth-demo-001', 'resolved', 'Fixed and tested');
  insertLog.run('CP-2024-003', 'user-demo-001', 'submitted', null);

  console.log('✅ Demo data seeded. Login: arjun@demo.com / demo1234 (citizen) | priya@ghmc.gov / demo1234 (authority)');
}

seedIfEmpty();

module.exports = db;