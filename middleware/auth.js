const jwt = require('jsonwebtoken');
const pool = require('../db/index');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const BCRYPT_ROUNDS = 10;

// Generate a random token for password reset
function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

// Create a session by storing JWT token in database
async function createSession(userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  await pool.query(
    'INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
    [userId, token]
  );
  return token;
}

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Middleware to check subscription status
function requireSubscription(req, res, next) {
  // This will be implemented to check user subscription status
  // For now, allow all authenticated users
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Middleware to check admin status
function requireAdmin(req, res, next) {
  // Check if user is admin (to be implemented based on your schema)
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id, 10)).filter(Boolean);
  if (!req.user || !adminIds.includes(req.user.id)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = {
  generateToken,
  createSession,
  authenticateToken,
  requireSubscription,
  requireAdmin,
  JWT_SECRET,
  BCRYPT_ROUNDS
};
