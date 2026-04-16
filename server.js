require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const knex = require('knex');
const KnexSessionStore = require('connect-session-knex')(session);

const knexConfig = require('./knexfile');
const db = knex(knexConfig);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session store
const store = new KnexSessionStore({ knex: db, tablename: 'sessions', createtable: true });
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret',
  resave: false,
  saveUninitialized: false,
  store,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production' && process.env.DATABASE_URL ? true : false,
    sameSite: 'lax'
  }
}));

// Trust proxy for Railway
if (process.env.DATABASE_URL) {
  app.set('trust proxy', 1);
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/artists', require('./routes/artists'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/revenue', require('./routes/revenue'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/income', require('./routes/income'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/youtube', require('./routes/youtube'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/users', require('./routes/users'));
app.use('/api/import', require('./routes/import'));

// SPA-like routing: serve pages
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html')));
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html')));
app.get('/artists', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'artists.html')));
app.get('/artists/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'artist-detail.html')));
app.get('/youtube', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'youtube.html')));
// Public artist-facing connect page (no auth required)
app.get('/connect/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'connect.html')));
app.get('/referrals', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'referrals.html')));
app.get('/revenue/new', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'revenue-entry.html')));
app.get('/revenue', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'revenue-history.html')));
app.get('/expenses', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'expenses.html')));
app.get('/additional-income', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'additional-income.html')));
app.get('/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'reports.html')));
app.get('/user-breakdown', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'user-breakdown.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'settings.html')));

// Run migrations on startup, then start server
async function start() {
  try {
    // Ensure data directory exists for SQLite
    if (!process.env.DATABASE_URL) {
      const fs = require('fs');
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    }

    await db.migrate.latest();
    console.log('Database migrations complete');

    // Run seeds if users table is empty
    const userCount = await db('users').count('id as count').first();
    if (parseInt(userCount.count) === 0) {
      await db.seed.run();
      console.log('Database seeded with default data');
    }

    app.listen(PORT, () => {
      console.log(`Deng Parez Monetary System running on port ${PORT}`);
      console.log(`Open http://localhost:${PORT} in your browser`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
