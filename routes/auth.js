const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { generateToken, authenticateToken, logAudit } = require('../auth');

// Rate limiting map for failed login attempts: IP -> { count, resetAt }
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Background pruning of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (now > data.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

function getClientIp(req) {
  return (req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const clientIp = getClientIp(req);
  const now = Date.now();

  const attemptData = loginAttempts.get(clientIp);
  if (attemptData) {
    if (now < attemptData.resetAt && attemptData.count >= MAX_FAILED_ATTEMPTS) {
      const remainingMinutes = Math.ceil((attemptData.resetAt - now) / 60000);
      return res.status(429).json({
        error: `Too many failed login attempts. Security protection active. Please try again in ${remainingMinutes} minute(s).`
      });
    }
    if (now >= attemptData.resetAt) {
      loginAttempts.delete(clientIp);
    }
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const identifier = (username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)').get(identifier, identifier);

  function recordFailure() {
    const existing = loginAttempts.get(clientIp);
    if (!existing || now >= existing.resetAt) {
      loginAttempts.set(clientIp, { count: 1, resetAt: now + LOCKOUT_WINDOW_MS });
    } else {
      existing.count += 1;
    }
  }

  if (!user) {
    recordFailure();
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Your account is deactivated. Please contact an administrator.' });
  }

  const isMatch = bcrypt.compareSync(password, user.password_hash);
  if (!isMatch) {
    recordFailure();
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Clear failed attempts upon successful login
  loginAttempts.delete(clientIp);

  const token = generateToken(user);

  // Set HTTP-only cookie
  res.cookie('it_app_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  logAudit(user.id, user.username, 'LOGIN', 'user', user.id, 'User logged in successfully');

  res.json({
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    }
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('it_app_token');
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Incorrect current password.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const newHash = bcrypt.hashSync(new_password, salt);

  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, req.user.id);
  logAudit(req.user.id, req.user.username, 'CHANGE_PASSWORD', 'user', req.user.id, 'User changed their password');

  res.json({ message: 'Password changed successfully.' });
});

router._loginAttempts = loginAttempts;

module.exports = router;
