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

module.exports = {
  generateToken,
  createSession,
  authenticateToken,
  JWT_SECRET,
  BCRYPT_ROUNDS
};
