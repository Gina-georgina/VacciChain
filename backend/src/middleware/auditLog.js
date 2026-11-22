const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');

/**
 * Append a single audit entry to the append-only NDJSON log file.
 * This is the only write path — there is no update or delete.
 */
function writeAuditEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  // appendFileSync keeps writes atomic enough for a single-process server
  fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
}

/**
 * Build and persist an audit log entry.
 *
 * @param {object} opts
 * @param {string} opts.actor   - Stellar public key of the acting wallet
 * @param {string} opts.action  - e.g. 'vaccination.issue', 'auth.login'
 * @param {string} [opts.target] - Subject of the action (patient wallet, etc.)
 * @param {string} opts.result  - 'success' | 'failure'
 * @param {object} [opts.meta]  - Any extra context (token_id, error message, …)
 */
function audit({ actor, action, target = null, result, meta = {} }) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    target,
    result,
    meta,
  };
  writeAuditEntry(entry);
}

/**
 * Record a structured verifier API-key lifecycle event.
 *
 * Lifecycle actions:
 *   'verifier_key.provision', 'verifier_key.rotate', 'verifier_key.revoke'
 *
 * @param {object} opts
 * @param {string} opts.keyId   - Identifier of the verifier API key (actor)
 * @param {string} opts.action  - Lifecycle action (see above)
 * @param {string} [opts.target] - Verifier/org the key belongs to
 * @param {string} opts.result  - 'success' | 'failure'
 * @param {string[]} [opts.scopes] - Scopes attached to the key at event time
 * @param {string} [opts.reason]   - Human-readable reason (e.g. revocation cause)
 * @param {object} [opts.meta]     - Any extra context
 */
function auditVerifierKey({ keyId, action, target = null, result, scopes = [], reason = null, meta = {} }) {
  audit({
    actor: keyId,
    action,
    target,
    result,
    meta: { ...meta, scopes, reason },
  });
}
=======

/**
 * Read all audit entries, optionally filtered by actor and/or date range.
 *
 * @param {object} filters
 * @param {string} [filters.actor]  - exact wallet match
 * @param {string} [filters.from]   - ISO date string (inclusive)
 * @param {string} [filters.to]     - ISO date string (inclusive)
 * @returns {object[]}
 */
function queryAuditLog({ actor, action, from, to } = {}) {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];

  const fromMs = from ? new Date(from).getTime() : null;
  const toMs   = to   ? new Date(to).getTime()   : null;

  const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  return entries.filter(e => {
    if (actor && e.actor !== actor) return false;
    if (action && e.action !== action) return false;
    const ts = new Date(e.timestamp).getTime();
    if (fromMs && ts < fromMs) return false;
    if (toMs   && ts > toMs)   return false;
    return true;
  });
}

/**
 * Query audit entries for a single verifier API key, optionally narrowed to
 * one lifecycle action. Useful for asserting rotation/revocation history.
 *
 * @param {string} keyId
 * @param {object} [filters]
 * @param {string} [filters.action]
 * @param {string} [filters.from]
 * @param {string} [filters.to]
 * @returns {object[]}
 */
function queryVerifierKeyAudit(keyId, { action, from, to } = {}) {
  return queryAuditLog({ actor: keyId, action, from, to });
}

module.exports = { audit, auditVerifierKey, queryAuditLog, queryVerifierKeyAudit };
