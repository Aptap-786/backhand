'use strict';

/**
 * server.js
 * WhatsApp OTP Gateway – Main Express server
 * Deploy on Render as a Node.js Web Service
 */

require('dotenv').config();

const express              = require('express');
const cors                 = require('cors');
const { WhatsAppManager }  = require('./whatsapp-manager');
const buildRoutes          = require('./api-routes');

// ── Guard: API_KEY must be set ────────────────────────────────────────────────
if (!process.env.API_KEY) {
  console.error('FATAL: API_KEY environment variable is not set. Exiting.');
  process.exit(1);
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin:       '*',           // Tighten to your frontend domain in production
  methods:      ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Root – no auth needed (Render health check hits this) ─────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'WhatsApp OTP Gateway',
    version: '1.0.0',
    status:  'running',
    hint:    'Use GET /api/health?key=YOUR_API_KEY to test',
  });
});

// ── WhatsApp session manager ──────────────────────────────────────────────────
const manager = new WhatsAppManager();

const sessionNames = (process.env.SESSION_NAMES || 'personal')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

(async () => {
  console.log('='.repeat(50));
  console.log(' WhatsApp OTP Gateway starting…');
  console.log(`  Sessions : ${sessionNames.join(', ')}`);
  console.log(`  Port     : ${PORT}`);
  console.log('='.repeat(50));

  for (const name of sessionNames) {
    await manager.createSession(name);
    // Stagger starts to prevent Puppeteer race conditions
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log('All sessions booting. Scan QR at:');
  console.log(`  GET /api/qr?key=<API_KEY>&session=<name>`);
})();

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', buildRoutes(manager));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ status: false, error: 'Endpoint not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ status: false, error: 'Internal server error' });
});

// ── Listen ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Server listening on port ${PORT}`);
  console.log(`✓ API_KEY prefix: ${process.env.API_KEY.slice(0, 6)}…\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('SIGTERM – shutting down…');
  for (const [id] of manager.sessions) {
    await manager.removeSession(id);
  }
  process.exit(0);
});
