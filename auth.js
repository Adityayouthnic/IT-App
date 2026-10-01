const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('./database');

function getJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) {
    return process.env.JWT_SECRET.trim();
  }
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
    if (row && row.value && row.value.trim()) {
      return row.value.trim();
    }
    const generated = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jwt_secret', ?)").run(generated);
    return generated;
  } catch (err) {
    return 'it_app_secure_super_secret_key_2026_vbexport';
  }
}

const JWT_SECRET = getJwtSecret();

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authenticateToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.it_app_token) {
    token = req.cookies.it_app_token;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user is still active in database
    const user = db.prepare('SELECT id, username, full_name, email, role, status FROM users WHERE id = ?').get(decoded.id);
    if (!user || user.status !== 'active') {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'User account is inactive or not found.' });
      }
      return res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }
    return res.redirect('/login');
  }
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden: requires ${allowedRoles.join(' or ')} permission` });
    }
    next();
  };
}

function logAudit(userId, username, action, entityType, entityId, details) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId || null, username || 'system', action, entityType, String(entityId || ''), typeof details === 'object' ? JSON.stringify(details) : String(details || ''));
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

module.exports = {
  JWT_SECRET,
  generateToken,
  authenticateToken,
  requireRoles,
  logAudit
};
