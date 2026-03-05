'use strict';

/**
 * whatsapp-manager.js
 * Manages one or more WhatsApp Web sessions with OTP auto-detection.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode                = require('qrcode');
const qrcodeTerminal        = require('qrcode-terminal');
const { processMessage }    = require('./otp-detector');

const MAX_HISTORY = parseInt(process.env.MAX_OTP_HISTORY || '50', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Single WhatsApp Session
// ─────────────────────────────────────────────────────────────────────────────
class WhatsAppSession {
  constructor(sessionId) {
    this.sessionId    = sessionId;
    this.client       = null;
    this.status       = 'initializing'; // initializing | qr_pending | authenticated | connected | disconnected | auth_failed
    this.qrBase64     = null;           // data:image/png;base64,...
    this.qrString     = null;
    this.phoneNumber  = null;
    this.latestOTP    = null;
    this.otpHistory   = [];
    this.connectedAt  = null;
    this.lastActivity = null;
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  async initialize() {
    console.log(`[${this.sessionId}] Initializing…`);

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.sessionId }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
        ],
      },
    });

    this._bindEvents();

    // initialize() can throw; caller handles it
    await this.client.initialize();
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  _bindEvents() {
    this.client.on('qr', async (qr) => {
      console.log(`[${this.sessionId}] QR ready – scan in WhatsApp`);
      this.status    = 'qr_pending';
      this.qrString  = qr;
      this.qrBase64  = await qrcode.toDataURL(qr).catch(() => null);
      qrcodeTerminal.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => {
      console.log(`[${this.sessionId}] Authenticated ✓`);
      this.status   = 'authenticated';
      this.qrBase64 = null;
      this.qrString = null;
    });

    this.client.on('auth_failure', (msg) => {
      console.error(`[${this.sessionId}] Auth failure:`, msg);
      this.status = 'auth_failed';
    });

    this.client.on('ready', async () => {
      console.log(`[${this.sessionId}] Ready ✓`);
      this.status      = 'connected';
      this.connectedAt = new Date().toISOString();
      try {
        const info = this.client.info;
        this.phoneNumber = info?.wid?.user || null;
        if (this.phoneNumber) console.log(`[${this.sessionId}] Phone: +${this.phoneNumber}`);
      } catch (_) {}
    });

    this.client.on('disconnected', (reason) => {
      console.warn(`[${this.sessionId}] Disconnected – reason: ${reason}`);
      this.status      = 'disconnected';
      this.phoneNumber = null;
      this.connectedAt = null;
    });

    // Incoming messages
    this.client.on('message', (msg) => this._onMessage(msg));
  }

  _onMessage(msg) {
    try {
      const body   = (msg.body || '').trim();
      const sender = msg.from || 'unknown';
      if (!body) return;

      const result = processMessage(body, sender);
      if (!result) return;

      const entry = {
        id:           `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        session_id:   this.sessionId,
        otp:          result.otp,
        confidence:   result.confidence,
        message:      body,
        sender,
        detected_at:  result.detected_at,
      };

      console.log(`[${this.sessionId}] OTP: ${entry.otp} (${entry.confidence}) from ${sender}`);

      this.latestOTP    = entry;
      this.lastActivity = entry.detected_at;
      this.otpHistory.unshift(entry);
      if (this.otpHistory.length > MAX_HISTORY) {
        this.otpHistory.length = MAX_HISTORY;
      }
    } catch (err) {
      console.error(`[${this.sessionId}] Message error:`, err.message);
    }
  }

  // ── Public accessors ────────────────────────────────────────────────────────
  getStatus() {
    return {
      session_id:    this.sessionId,
      status:        this.status,
      phone_number:  this.phoneNumber,
      connected_at:  this.connectedAt,
      last_activity: this.lastActivity,
      has_qr:        !!this.qrBase64,
    };
  }

  getQR() {
    return {
      session_id: this.sessionId,
      status:     this.status,
      qr_image:   this.qrBase64,
      qr_string:  this.qrString,
    };
  }

  getLatestOTP() { return this.latestOTP; }

  getHistory(limit = 20) {
    return this.otpHistory.slice(0, Math.min(limit, MAX_HISTORY));
  }

  clearOTPs() {
    this.latestOTP    = null;
    this.otpHistory   = [];
    this.lastActivity = null;
  }

  async logout() {
    try { await this.client?.logout(); } catch (_) {}
    this.status      = 'disconnected';
    this.phoneNumber = null;
    this.qrBase64    = null;
    this.qrString    = null;
  }

  async destroy() {
    try { await this.client?.destroy(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager (multi-session)
// ─────────────────────────────────────────────────────────────────────────────
class WhatsAppManager {
  constructor() {
    this.sessions = new Map(); // sessionId → WhatsAppSession
  }

  async createSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const session = new WhatsAppSession(sessionId);
    this.sessions.set(sessionId, session);

    // Boot in background – don't block server startup
    session.initialize().catch((err) => {
      console.error(`[${sessionId}] Init error:`, err.message);
      session.status = 'auth_failed';
    });

    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getAllStatuses() {
    return Array.from(this.sessions.values()).map((s) => s.getStatus());
  }

  getGlobalLatest() {
    let latest = null;
    for (const s of this.sessions.values()) {
      const otp = s.getLatestOTP();
      if (!otp) continue;
      if (!latest || otp.detected_at > latest.detected_at) latest = otp;
    }
    return latest;
  }

  getGlobalHistory(limit = 20) {
    const all = [];
    for (const s of this.sessions.values()) {
      all.push(...s.getHistory(MAX_HISTORY));
    }
    all.sort((a, b) => (b.detected_at > a.detected_at ? 1 : -1));
    return all.slice(0, limit);
  }

  async removeSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) {
      await s.destroy();
      this.sessions.delete(sessionId);
    }
  }
}

module.exports = { WhatsAppManager, WhatsAppSession };
