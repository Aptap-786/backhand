'use strict';

/**
 * api-routes.js
 * Express router – all REST API endpoints for the OTP Gateway.
 */

const express = require('express');

// ─────────────────────────────────────────────────────────────────────────────
// API Key middleware
// ─────────────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const key =
    req.query.key ||
    req.headers['x-api-key'] ||
    (req.body && req.body.key);

  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ status: false, error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper – resolve a session from ?session= param
// ─────────────────────────────────────────────────────────────────────────────
function resolveSession(manager, req, res) {
  const id = req.query.session || 'personal';
  const s  = manager.getSession(id);
  if (!s) {
    res.status(404).json({ status: false, error: `Session '${id}' not found` });
    return null;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function buildRoutes(manager) {
  const router = express.Router();
  router.use(auth);

  // ── GET /api/health ──────────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({
      status:      true,
      service:     'WhatsApp OTP Gateway',
      version:     '1.0.0',
      uptime_sec:  Math.floor(process.uptime()),
      sessions:    manager.getAllStatuses().length,
      timestamp:   new Date().toISOString(),
    });
  });

  // ── GET /api/status ──────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    res.json({
      status:   true,
      sessions: manager.getAllStatuses(),
      uptime:   process.uptime(),
    });
  });

  // ── GET /api/qr?session=personal ────────────────────────────────────────
  router.get('/qr', (req, res) => {
    const session = resolveSession(manager, req, res);
    if (!session) return;

    const qr = session.getQR();

    if (!qr.qr_image) {
      return res.json({
        status:         false,
        session_status: session.status,
        message:        session.status === 'connected'
          ? 'Already connected – no QR needed'
          : 'QR not ready yet, please wait a few seconds…',
      });
    }

    res.json({
      status:     true,
      session_id: qr.session_id,
      qr_image:   qr.qr_image,   // data:image/png;base64,…
      qr_string:  qr.qr_string,
    });
  });

  // ── GET /api/latest-otp ──────────────────────────────────────────────────
  router.get('/latest-otp', (req, res) => {
    let entry;

    if (req.query.session) {
      const session = resolveSession(manager, req, res);
      if (!session) return;
      entry = session.getLatestOTP();
    } else {
      entry = manager.getGlobalLatest();
    }

    if (!entry) {
      return res.json({ status: false, otp: null, message: 'No OTP detected yet' });
    }

    res.json({
      status:      true,
      otp:         entry.otp,
      message:     `Your OTP is ${entry.otp}`,
      sender:      entry.sender,
      confidence:  entry.confidence,
      session_id:  entry.session_id,
      detected_at: entry.detected_at,
      raw_message: entry.message,
    });
  });

  // ── GET /api/otp-history ─────────────────────────────────────────────────
  router.get('/otp-history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    let history;
    if (req.query.session) {
      const session = resolveSession(manager, req, res);
      if (!session) return;
      history = session.getHistory(limit);
    } else {
      history = manager.getGlobalHistory(limit);
    }

    res.json({ status: true, count: history.length, history });
  });

  // ── POST /api/clear ──────────────────────────────────────────────────────
  router.post('/clear', (req, res) => {
    if (req.query.session) {
      const session = resolveSession(manager, req, res);
      if (!session) return;
      session.clearOTPs();
      return res.json({ status: true, message: `OTPs cleared for '${req.query.session}'` });
    }

    for (const s of manager.sessions.values()) s.clearOTPs();
    res.json({ status: true, message: 'All OTPs cleared' });
  });

  // ── POST /api/session/create ─────────────────────────────────────────────
  router.post('/session/create', async (req, res) => {
    const id = (req.body?.session_id || req.query.session_id || '').trim();

    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).json({
        status: false,
        error:  'Invalid session_id – use alphanumeric, hyphens, underscores only',
      });
    }

    if (manager.getSession(id)) {
      return res.json({
        status:  false,
        message: `Session '${id}' already exists`,
        session: manager.getSession(id).getStatus(),
      });
    }

    await manager.createSession(id);
    res.json({
      status:  true,
      message: `Session '${id}' created. Scan QR to connect.`,
      session: manager.getSession(id).getStatus(),
    });
  });

  // ── POST /api/session/logout ─────────────────────────────────────────────
  router.post('/session/logout', async (req, res) => {
    const session = resolveSession(manager, req, res);
    if (!session) return;
    await session.logout();
    res.json({ status: true, message: `Session '${session.sessionId}' logged out` });
  });

  return router;
};
