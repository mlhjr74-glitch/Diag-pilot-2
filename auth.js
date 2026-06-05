// Owns: /api/auth/* — signup, login, logout, me, password reset
// Does NOT own: subscription status, user profile updates

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('./db/index');
const { generateToken, createSession, authenticateToken, BCRYPT_ROUNDS } = require('./middleware/auth');
const { logEvent } = require('./db/events');

const router = express.Router();

const APP_URL = process.env.APP_URL || 'https://diagpilot.polsia.app';

router.post('/signup', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  const ua = req.headers['user-agent'] || null;

  try {
    const { name, email, password } = req.body;
    if (!email || !password) {
      logEvent({ eventType: 'signup_attempt', email, ipAddress: ip, userAgent: ua, metadata: { reason: 'missing_fields' } });
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!name?.trim()) {
      logEvent({ eventType: 'signup_attempt', email, ipAddress: ip, userAgent: ua, metadata: { reason: 'missing_name' } });
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (password.length < 8) {
      logEvent({ eventType: 'signup_attempt', email, ipAddress: ip, userAgent: ua, metadata: { reason: 'password_too_short' } });
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!/^[^\n@]+@[^\n@]+\.[^\n@]+$/.test(email)) {
      logEvent({ eventType: 'signup_attempt', email, ipAddress: ip, userAgent: ua, metadata: { reason: 'invalid_email' } });
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      logEvent({ eventType: 'signup_attempt', email: normalizedEmail, ipAddress: ip, userAgent: ua, metadata: { reason: 'email_exists' } });
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
      [normalizedEmail, name.trim(), passwordHash]
    );
    const user = result.rows[0];
    const token = await createSession(user.id);
    logEvent({ eventType: 'signup_success', email: user.email, ipAddress: ip, userAgent: ua, metadata: { userId: user.id } });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Signup error:', err);
    logEvent({ eventType: 'signup_attempt', email: req.body.email, ipAddress: ip, userAgent: ua, metadata: { reason: 'server_error', message: err.message } });
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  const ua = req.headers['user-agent'] || null;

  try {
    const { email, password } = req.body;
    if (!email || !password) {
      logEvent({ eventType: 'login_attempt', email, ipAddress: ip, userAgent: ua, metadata: { reason: 'missing_fields' } });
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query('SELECT id, email, name, password_hash FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

    if (result.rows.length === 0) {
      logEvent({ eventType: 'login_attempt', email: normalizedEmail, ipAddress: ip, userAgent: ua, metadata: { reason: 'no_account' } });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!result.rows[0].password_hash) {
      logEvent({ eventType: 'login_attempt', email: normalizedEmail, ipAddress: ip, userAgent: ua, metadata: { reason: 'no_password_set' } });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) {
      logEvent({ eventType: 'login_attempt', email: user.email, ipAddress: ip, userAgent: ua, metadata: { reason: 'wrong_password' } });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = await createSession(user.id);
    logEvent({ eventType: 'login_success', email: user.email, ipAddress: ip, userAgent: ua, metadata: { userId: user.id } });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    logEvent({ eventType: 'login_attempt', email: req.body.email, ipAddress: ip, userAgent: ua, metadata: { reason: 'server_error', message: err.message } });
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Logout error:', err);
    res.json({ message: 'Logged out.' });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  // no-store: subscription_status must always reflect current DB state; ETag caching causes stale Free badge
  res.set('Cache-Control', 'no-store').json({ user: req.user });
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const normalizedEmail = email.trim().toLowerCase();
    const genericMessage = 'If an account with that email exists, a password reset link has been sent.';
    const userResult = await pool.query('SELECT id, email, name FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (userResult.rows.length === 0) return res.json({ message: genericMessage });

    const user = userResult.rows[0];
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);

    const resetToken = generateToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    await pool.query('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)', [user.id, resetToken, expiresAt]);

    const resetUrl = `${APP_URL}/auth.html?reset=${resetToken}`;
    const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
    if (postmarkToken) {
      try {
        const emailRes = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json', 'Content-Type': 'application/json',
            'X-Postmark-Server-Token': postmarkToken
          },
          body: JSON.stringify({
            From: 'DiagPilot <noreply@diagpilot.polsia.app>',
            To: user.email,
            Subject: 'Reset Your DiagPilot Password',
            HtmlBody: `<div style=\"font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px\">
              <h1 style=\"font-size:24px;color:#0a0e17\">Diag<span style=\"color:#22d3ee\">Pilot</span></h1>
              <h2>Reset Your Password</h2>
              <p style=\"color:#64748b;font-size:15px;line-height:1.6\">Hi ${user.name || 'there'}, click below to reset your DiagPilot password. This link expires in 1 hour.</p>
              <div style=\"margin:24px 0\"><a href=\"${resetUrl}\" style=\"display:inline-block;padding:14px 32px;background:#22d3ee;color:#0a0e17;font-weight:700;text-decoration:none;border-radi[...]
              <p style=\"color:#94a3b8;font-size:13px\">If you didn't request this, ignore this email.</p>
            </div>`,
            TextBody: `Reset your DiagPilot password: ${resetUrl}\n\nExpires in 1 hour.`
          })
        });
        if (!emailRes.ok) console.error('Postmark error:', await emailRes.text());
      } catch (emailErr) {
        console.error('Failed to send reset email:', emailErr.message);
      }
    } else {
      console.log(`[PASSWORD RESET] ${user.email} | ${resetUrl}`);
    }

    res.json({ message: genericMessage });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request. Please try again.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const tokenResult = await pool.query(
      'SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token = $1 AND used_at IS NULL',
      [token]
    );
    if (tokenResult.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });

    const record = tokenResult.rows[0];
    if (new Date(record.expires_at) < new Date()) {
      await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, record.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [record.user_id]);

    res.json({ message: 'Password reset successfully. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

module.exports = router;
