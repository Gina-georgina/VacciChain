const fs = require('fs');
const path = require('path');
const db = require('../db');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');

/**
 * Audit log retention policy.
 *
 * Data class: AUDIT (compliance / security audit trail).
 * Retention: AUDIT_RETENTION_DAYS (default 2555 days ≈ 7 years).
 * Constraints:
 *   - The audit log is append-only. Entries are never updated or deleted
 *     by application code paths; the only deletion mechanism is the
 *     scheduled retention job (see `purgeAuditLog`) operating under policy.
 *   - Entries flagged as required for compliance or recovery
 *     (`meta.retain === true`, or actions listed in
 *     AUDIT_PROTECTED_ACTIONS) are never purged, regardless of age.
 *   - Entries newer than the retention window are always kept.
 */
const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || '2555', 10);

// Actions that must be retained for compliance/recovery and are exempt from purge.
const AUDIT_PROTECTED_ACTIONS = new Set(
  (process.env.AUDIT_PROTECTED_ACTIONS || 'auth.login,recovery.restore,recovery.initiate')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
);

/**
 * Append a single audit entry to the append-only NDJSON log file.
 * This is the only write path — there is no update or delete.
 *
 * Kept for backward compatibility; database audit entries are the
 * authoritative, transactionally-committed record.
 */
function writeAuditEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  // appendFileSync keeps writes atomic enough for a single-process server
  fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
}

/**
 * Insert an audit entry into the database using the supplied client.
 *
 * The caller is responsible for the surrounding transaction (BEGIN/COMMIT/
 * ROLLBACK) so that the audit record commits atomically with the other
 * writes it accompanies. If no client is supplied, a standalone connection
 * is used and the insert is committed on its own.
 *
 * @param {object} entry
 * @param {object} [client] - pg client participating in an existing transaction
 * @returns {Promise<object>} the persisted entry
 */
async function writeAuditEntryTx(entry, client) {
  const sql = `
    INSERT INTO audit_log (timestamp, actor, action, target, result, meta)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, timestamp, actor, action, target, result, meta
  `;
  const params = [
    entry.timestamp,
    entry.actor,
    entry.action,
    entry.target,
    entry.result,
    JSON.stringify(entry.meta || {}),
  ];

  if (client) {
    const { rows } = await client.query(sql, params);
    return rows[0];
  }

  // Standalone: run inside its own transaction so the insert is atomic.
  const ownClient = await db.getClient();
  try {
    await ownClient.query('BEGIN');
    const { rows } = await ownClient.query(sql, params);
    await ownClient.query('COMMIT');
    return rows[0];
  } catch (err) {
    await ownClient.query('ROLLBACK');
    throw err;
  } finally {
    ownClient.release();
  }
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
 * Persist an audit entry atomically alongside other writes.
 *
 * When a transaction client is provided, the audit row is inserted using that
 * client so it commits (or rolls back) together with the surrounding
 * multi-step operation. The append-only NDJSON log is still written for
 * backward compatibility, but only after the database insert succeeds so a
 * failed transaction does not leave a phantom file entry.
 *
 * @param {object} opts - same shape as `audit`
 * @param {object} [client] - pg client participating in an existing transaction
 * @returns {Promise<object>} the persisted database entry
 */
async function auditTx({ actor, action, target = null, result, meta = {} }, client) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    target,
    result,
    meta,
  };
  const persisted = await writeAuditEntryTx(entry, client);
  writeAuditEntry(entry);
  return persisted;
}

/**
 * Read all audit entries, optionally filtered by actor and/or date range.
 *
 * @param {object} filters
 * @param {string} [filters.actor]  - exact wallet match
 * @param {string} [filters.from]   - ISO date string (inclusive)
 * @param {string} [filters.to]     - ISO date string (inclusive)
 * @returns {object[]}
 */
function queryAuditLog({ actor, from, to } = {}) {
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
    const ts = new Date(e.timestamp).getTime();
    if (fromMs && ts < fromMs) return false;
    if (toMs   && ts > toMs)   return false;
    return true;
  });
}

/**
 * Determine whether an audit entry must be retained regardless of age.
 * Protected entries are those explicitly flagged for retention or whose
 * action is part of the compliance/recovery protected set.
 */
function isProtectedEntry(entry) {
  if (!entry || typeof entry !== 'object') return true; // keep unparseable/unknown
  if (entry.meta && entry.meta.retain === true) return true;
  if (entry.action && AUDIT_PROTECTED_ACTIONS.has(entry.action)) return true;
  return false;
}

/**
 * Retention-aware purge of the audit log.
 *
 * Removes entries older than the configured retention window
 * (AUDIT_RETENTION_DAYS) while refusing to delete entries required for
 * compliance or recovery. The audit log is append-only; this scheduled job
 * is the only sanctioned deletion path.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now]            - Reference time (defaults to now)
 * @param {number} [opts.retentionDays]  - Override retention window
 * @param {boolean}[opts.dryRun]         - If true, compute but do not write
 * @returns {{purged: number, retained: number, protected: number, dryRun: boolean}}
 */
function purgeAuditLog({ now = new Date(), retentionDays = AUDIT_RETENTION_DAYS, dryRun = false } = {}) {
  const result = { purged: 0, retained: 0, protected: 0, dryRun };

  if (!fs.existsSync(AUDIT_LOG_PATH)) return result;

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  const kept = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Never drop unparseable lines — they may be needed for recovery.
      kept.push(line);
      result.protected += 1;
      continue;
    }

    const ts = new Date(entry.timestamp).getTime();
    const expired = Number.isFinite(ts) && ts < cutoffMs;

    if (!expired) {
      kept.push(line);
      result.retained += 1;
    } else if (isProtectedEntry(entry)) {
      kept.push(line);
      result.protected += 1;
    } else {
      result.purged += 1;
    }
  }

  if (!dryRun && result.purged > 0) {
    const tmpPath = `${AUDIT_LOG_PATH}.purge.tmp`;
    fs.writeFileSync(tmpPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    fs.renameSync(tmpPath, AUDIT_LOG_PATH);
  }

  return result;
}

module.exports = {
  audit,
  auditTx,
  writeAuditEntryTx,
  queryAuditLog,
  purgeAuditLog,
  isProtectedEntry,
  AUDIT_RETENTION_DAYS,
  AUDIT_PROTECTED_ACTIONS,
};
