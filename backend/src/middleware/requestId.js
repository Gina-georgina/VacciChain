const { randomUUID } = require('crypto');

// Accept only well-formed, bounded request IDs from clients. Anything else is
// replaced with a freshly generated UUID so that untrusted input cannot inject
// control characters, forge log correlation, or bloat audit records.
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isValidRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function normalizeHeaderValue(value) {
  // Node may surface repeated headers as an array; only accept a single value.
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return value;
}

module.exports = function requestId(req, res, next) {
  const provided = normalizeHeaderValue(req.headers['x-request-id']);
  const id = isValidRequestId(provided) ? provided : randomUUID();

  // Expose the request ID to downstream middleware (including audit logging)
  // and to route handlers for correlation.
  req.requestId = id;
  req.id = id;

  // Echo the sanitized ID back so clients can correlate their requests.
  res.setHeader('X-Request-ID', id);

  next();
};

module.exports.isValidRequestId = isValidRequestId;
module.exports.MAX_REQUEST_ID_LENGTH = MAX_REQUEST_ID_LENGTH;