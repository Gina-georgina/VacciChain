const logger = require('../logger');

/**
 * Patterns that match sensitive values which must never reach logs.
 * Each entry replaces the matched secret with a redaction marker.
 */
const SENSITIVE_PATTERNS = [
  // JSON Web Tokens (three base64url segments separated by dots)
  {
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED_JWT]',
  },
  // Bearer tokens in header-like strings
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  // key=value / key: value pairs for common secret field names
  {
    regex: /\b(secret|secretKey|secret_key|apiKey|api_key|privateKey|private_key|password|passwd|token|accessToken|access_token|refreshToken|refresh_token|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: '$1=[REDACTED]',
  },
  // Signed transaction payloads (hex blobs of 64+ chars)
  {
    regex: /\b0x[0-9a-fA-F]{64,}\b/g,
    replacement: '[REDACTED_SIGNED_PAYLOAD]',
  },
  // Long raw hex blobs (signed payloads without 0x prefix)
  {
    regex: /\b[0-9a-fA-F]{128,}\b/g,
    replacement: '[REDACTED_SIGNED_PAYLOAD]',
  },
];

/**
 * Redact sensitive values (JWTs, secret keys, signed payloads) from a string.
 *
 * @param {unknown} value
 * @returns {unknown} redacted string, or the original value if not a string
 */
function redactSensitive(value) {
  if (typeof value !== 'string') {
    return value;
  }

  let redacted = value;
  for (const { regex, replacement } of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(regex, replacement);
  }
  return redacted;
}

/**
 * Global error handler middleware.
 *
 * Operational errors (statusCode 4xx set on the error object) are returned
 * with their message. Unexpected errors (5xx) log the full stack but only
 * return a generic message so internals are never exposed in production.
 *
 * Sensitive values (JWTs, secret keys, signed payloads) are redacted from the
 * logged message and stack. Raw request headers and bodies are never logged.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  const isOperational = statusCode >= 400 && statusCode < 500;

  logger.error('unhandled error', {
    requestId: req.requestId,
    message: redactSensitive(err.message),
    stack: redactSensitive(err.stack),
    statusCode,
  });

  const body = {
    error: isOperational ? err.message : 'Internal Server Error',
    requestId: req.requestId,
  };

  res.status(statusCode).json(body);
}

module.exports = errorHandler;
module.exports.redactSensitive = redactSensitive;