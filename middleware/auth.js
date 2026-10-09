const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production' ? null : 'civicpulse-local-development-secret');

if (!secret) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    secret,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

function requireAuthority(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role !== 'authority') {
      return res.status(403).json({ success: false, message: 'Authority access required' });
    }
    next();
  });
}

module.exports = { generateToken, requireAuth, requireAuthority };
