const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// Initialize database
const { db } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));

// Serve Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health check endpoint for Railway & monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// All other routes serve main app (SPA fallback)
app.use((req, res) => {
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
  console.log(`🔐 Default Admin: admin / admin123`);
  console.log(`===============================================`);
});

module.exports = { app, server };
