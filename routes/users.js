const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, first_name, last_name, email, phone, role, dept, auth_id, created_at
    FROM users
    WHERE id = ?
  `).get(req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      COALESCE(SUM(upvotes), 0) AS total_upvotes_received
    FROM reports
    WHERE user_id = ?
  `).get(req.user.id);

  res.json({
    success: true,
    user,
    stats: {
      total: stats.total,
      pending: stats.pending || 0,
      accepted: stats.accepted || 0,
      resolved: stats.resolved || 0,
      rejected: stats.rejected || 0,
      total_upvotes_received: stats.total_upvotes_received,
    },
  });
});

module.exports = router;
