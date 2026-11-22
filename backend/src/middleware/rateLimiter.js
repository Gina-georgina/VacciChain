const rateLimit = require('express-rate-limit');

const make = (maxEnvVar, defaultMax, keyGen) =>
  rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env[maxEnvVar] ?? defaultMax, 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyGen,
    handler: (_req, res, _next, options) =>
      res.status(429).json({ error: 'Too many requests', retryAfter: options.windowMs / 1000 }),
  });

// Derive the client IP safely. Express resolves req.ip according to the
// configured `trust proxy` setting, so forwarded headers (X-Forwarded-For,
// etc.) are only honored when the deployment topology says they should be.
// This prevents spoofed forwarded headers from bypassing rate limits.
const clientIp = (req) => {
  const ip = req.ip;
  if (typeof ip === 'string' && ip.length > 0) return ip;
  // Fall back to the raw socket address if req.ip is unavailable.
  const socketIp = req.socket?.remoteAddress;
  if (typeof socketIp === 'string' && socketIp.length > 0) return socketIp;
  // Last-resort fallback so requests are still bucketed rather than sharing
  // an undefined key.
  return 'unknown';
};

module.exports = {
  clientIp,
  verifyLimiter:    make('RATE_LIMIT_VERIFY', 60, clientIp),
  sep10Limiter:     make('RATE_LIMIT_SEP10', 10, clientIp),
  // Keyed by verifier API key id so each third-party has its own bucket
  verifierKeyLimiter: make('RATE_LIMIT_VERIFIER_KEY', 120, (req) => req.verifier?.id ?? clientIp(req)),
};