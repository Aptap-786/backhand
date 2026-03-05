'use strict';

/**
 * otp-detector.js
 * Detects OTP / verification codes from WhatsApp message text.
 * Uses tiered regex patterns: high-confidence first, fallback last.
 */

const PATTERNS = [
  // Tier 1 – Explicit OTP keyword + number
  { re: /\b(?:OTP|one[- ]time[- ](?:password|code|pin))[^\d]{0,20}(\d{4,8})\b/i,    tier: 'high'   },
  { re: /\b(\d{4,8})[^\d]{0,10}(?:is|as)\s+your\s+(?:OTP|one[- ]time)/i,            tier: 'high'   },

  // Tier 2 – Verification / auth keywords
  { re: /\b(?:verification|confirm(?:ation)?)\s+(?:code|pin|number)[^\d]{0,10}(\d{4,8})\b/i, tier: 'medium' },
  { re: /\b(?:code|pin|token|password)[^\d]{0,5}[=:]\s*(\d{4,8})\b/i,               tier: 'medium' },
  { re: /\buse\s+(\d{4,8})\s+(?:to|as|for)\b/i,                                      tier: 'medium' },
  { re: /\benter\s+(\d{4,8})\b/i,                                                     tier: 'medium' },

  // Tier 3 – Standalone digit sequences (most common OTP lengths first)
  { re: /\b(\d{6})\b/, tier: 'low' },
  { re: /\b(\d{4})\b/, tier: 'low' },
  { re: /\b(\d{8})\b/, tier: 'low' },
  { re: /\b(\d{5})\b/, tier: 'low' },
  { re: /\b(\d{7})\b/, tier: 'low' },
];

// Numbers that are almost never OTPs
const BLOCKLIST = new Set([
  '0000', '1234', '12345', '123456', '1234567', '12345678',
]);

/**
 * Detect OTP in a message body.
 * @param {string} body
 * @returns {{ otp: string|null, confidence: string }}
 */
function detectOTP(body) {
  if (!body || typeof body !== 'string') return { otp: null, confidence: 'none' };

  const lc = body.toLowerCase();
  const hasKeyword = /\b(otp|code|pin|verify|verification|auth|token|password|secure|confirm)\b/.test(lc);

  for (const { re, tier } of PATTERNS) {
    const m = body.match(re);
    if (!m) continue;

    const otp = m[1];
    if (BLOCKLIST.has(otp)) continue;

    // Skip years in 4-digit matches
    if (otp.length === 4) {
      const n = parseInt(otp, 10);
      if (n >= 1900 && n <= 2100) continue;
    }

    // Upgrade low-tier confidence if keyword present
    const confidence = (tier === 'low' && hasKeyword) ? 'medium' : tier;
    return { otp, confidence };
  }

  return { otp: null, confidence: 'none' };
}

/**
 * Process a WhatsApp message.
 * @param {string} body   Message text
 * @param {string} sender Sender JID
 * @returns {object|null} Detection result or null if no OTP found
 */
function processMessage(body, sender) {
  const { otp, confidence } = detectOTP(body);
  if (!otp) return null;

  return {
    otp,
    confidence,
    message:      body,
    sender:       sender || 'unknown',
    detected_at:  new Date().toISOString(),
  };
}

module.exports = { detectOTP, processMessage };
