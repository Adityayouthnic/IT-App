const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// Initialize database
const { db } = require('./database');
const { authenticateToken, JWT_SECRET } = require('./auth');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Trust proxy for reverse proxy environments (Railway, Cloudflare, etc.)
app.set('trust proxy', 1);

// 2. Disable tech-stack fingerprinting
app.disable('x-powered-by');

// 3. Security Headers Middleware (Zero-Trust Defense-in-Depth)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Enforce HSTS when on HTTPS or production
  if (process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Content Security Policy (CSP)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https: blob:; " +
    "connect-src 'self' https:;"
  );

  next();
});

// 4. Strict Path Traversal & Sensitive File Exposure Shield
app.use((req, res, next) => {
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch (e) {
    return res.status(400).send('Bad Request');
  }

  // Block path traversal and null-byte injection
  if (decodedPath.includes('..') || decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return res.status(403).send('Forbidden: Path Traversal Detected');
  }

  // Block direct requests attempting to download database, env, git, config, or source code files
  if (/\.(db|sqlite|sqlite3|env|git|json|md|bak|sql|log|ya?ml)$/i.test(decodedPath)) {
    return res.status(404).send('Not Found');
  }

  next();
});

// 5. Standard Body Parsers & Cookie Parser
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 6. Public Endpoints (Must be reachable before login)
// Health check endpoint for Railway & uptime monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Serve Login page (Public)
app.get(['/login', '/login.html'], (req, res) => {
  // If user is already authenticated with a valid token, redirect to dashboard
  const token = (req.cookies && req.cookies.it_app_token) || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].substring(7) : null);
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return res.redirect('/');
    } catch (e) {
      // Invalid/expired token: clear cookie and let them see login page
      res.clearCookie('it_app_token');
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Mount Public & Protected Auth Routes
app.use('/api/auth', require('./routes/auth'));

// Mount Protected API Routes (All /api routes require authentication via authenticateToken)
app.use('/api', require('./routes/api'));

// 7. Strict Server-Side Authentication Gatekeeper for Frontend Application
// Unauthenticated visitors CANNOT access index.html, styles, or client scripts
app.use((req, res, next) => {
  // Allow public access to login page and branding/favicon assets
  if (
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path.startsWith('/favicon') ||
    req.path.startsWith('/apple-touch-icon')
  ) {
    return next();
  }

  // Check authentication
  authenticateToken(req, res, next);
});

// Serve static frontend assets for authenticated sessions only (index: false prevents auto-serving index.html without check)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve Main Application Dashboard (SPA root) for authenticated users
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SPA Fallback: Any unknown authenticated page request serves main index.html
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint Not Found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 IT Asset Web App is running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🔐 Default Admin: admin / Aditya@123`);
  console.log(`🛡️ Enterprise Zero-Leakage & Gatekeeper Active`);
  console.log(`===============================================`);
});

module.exports = { app, server };
