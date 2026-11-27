const { randomUUID } = require('crypto');

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:\-]+$/;

function sanitizeRequestId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function getLogger() {
  try {
    // Route logging through the redaction-aware logger so sensitive values
    // (JWTs, secret keys, signed payloads) never reach log records.
    return require('../lib/logger');
  } catch (err) {
    return null;
  }
}

module.exports = function requestId(req, res, next) {
  const incoming = sanitizeRequestId(req.headers['x-request-id']);
  const id = incoming || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);

  const logger = getLogger();
  if (logger && typeof logger.debug === 'function') {
    try {
      logger.debug({ requestId: id }, 'request received');
    } catch (err) {
      // Logging must never break request handling.
    }
  }

  next();
};

module.exports.sanitizeRequestId = sanitizeRequestId;
module.exports.MAX_REQUEST_ID_LENGTH = MAX_REQUEST_ID_LENGTH;