const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../audit.log');
const AUDIT_LOG_DIR = path.dirname(AUDIT_LOG_PATH);
const AUDIT_LOG_BASENAME = path.basename(AUDIT_LOG_PATH);

// Rotation / retention configuration.
const MAX_LOG_BYTES = parseInt(process.env.AUDIT_LOG_MAX_BYTES || String(10 * 1024 * 1024), 10);
const MAX_ROTATED_FILES = parseInt(process.env.AUDIT_LOG_MAX_ROTATED || '5', 10);
const RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '30', 10);

// Keys that must never be written to the audit log (sensitive data guard).
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|private[_-]?key|seed|mnemonic|authorization|cookie|api[_-]?key|credential)/i;

// Genesis hash used as the "previous hash" for the very first entry.
const GENESIS_HASH = '0'.repeat(64);

/**
 * Recursively redact sensitive values from an arbitrary object so that
 * secrets never end up in the audit trail.
 */
function redactSensitive(value, depth = 0) {
  if (depth > 8) return '[redacted:depth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[redacted]' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Compute the tamper-evident hash for an entry. The hash covers the entry
 * content plus the previous entry's hash, forming a hash chain.
 */
function computeEntryHash(entry, prevHash) {
  const payload = JSON.stringify({
    prevHash,
    timestamp: entry.timestamp,
    actor: entry.actor,
    requestId: entry.requestId,
    action: entry.action,
    target: entry.target,
    result: entry.result,
    meta: entry.meta,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Read the last line of the audit log to recover the current chain head.
 * Returns GENESIS_HASH when the log is empty or missing.
 */
function readLastHash() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return GENESIS_HASH;
    const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return GENESIS_HASH;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.hash || GENESIS_HASH;
  } catch (err) {
    // A corrupt tail must not silently break the chain; surface it.
    throw new Error(`audit: unable to read chain head: ${err.message}`);
  }
}

/**
 * Rotate the active log file when it exceeds MAX_LOG_BYTES, pruning old
 * rotated files beyond MAX_ROTATED_FILES / RETENTION_DAYS.
 * Rotation is best-effort: failures are logged to stderr but never throw,
 * so a rotation problem cannot take down the request path.
 */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return;
    const { size } = fs.statSync(AUDIT_LOG_PATH);
    if (size < MAX_LOG_BYTES) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(AUDIT_LOG_DIR, `${AUDIT_LOG_BASENAME}.${stamp}`);
    fs.renameSync(AUDIT_LOG_PATH, rotated);
    pruneRotatedFiles();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`audit: rotation failed: ${err.message}`);
  }
}

/**
 * Remove rotated files that exceed the retention window or count limit.
 */
function pruneRotatedFiles() {
  try {
    const prefix = `${AUDIT_LOG_BASENAME}.`;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rotated = fs
      .readdirSync(AUDIT_LOG_DIR)
      .filter(f => f.startsWith(prefix) && f !== AUDIT_LOG_BASENAME)
      .map(f => {
        const full = path.join(AUDIT_LOG_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    rotated.forEach((file, idx) => {
      const tooOld = file.mtime < cutoff;
      const tooMany = idx >= MAX_ROTATED_FILES;
      if (tooOld || tooMany) {
        try { fs.unlinkSync(file.full); } catch { /* ignore */ }
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`audit: retention pruning failed: ${err.message}`);
  }
}

/**
 * Append a single audit entry to the append-only NDJSON log file.
 * This is the only write path — there is no update or delete.
 * The entry is hash-chained to the previous entry for tamper evidence.
 */
function writeAuditEntry(entry) {
  rotateIfNeeded();
  const prevHash = readLastHash();
  const hash = computeEntryHash(entry, prevHash);
  const record = { ...entry, prevHash, hash };
  const line = JSON.stringify(record) + '\n';
  // appendFileSync keeps writes atomic enough for a single-process server
  fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf8');
}

/**
 * Build and persist an audit log entry.
 *
 * @param {object} opts
 * @param {string} opts.actor     - Stellar public key of the acting wallet
 * @param {string} [opts.requestId] - Correlation ID for the originating request
 * @param {string} opts.action    - e.g. 'vaccination.issue', 'auth.login'
 * @param {string} [opts.target]  - Subject of the action (patient wallet, etc.)
 * @param {string} opts.result    - 'success' | 'failure'
 * @param {object} [opts.meta]    - Any extra context (token_id, error message, …)
 */
function audit({ actor, requestId = null, action, target = null, result, meta = {} }) {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    requestId,
    action,
    target,
    result,
    meta: redactSensitive(meta),
  };
  writeAuditEntry(entry);
}

/**
 * Verify the integrity of the hash chain across the active log file.
 *
 * @returns {{ valid: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
function verifyAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    return { valid: true, entries: 0, brokenAt: null, reason: null };
  }
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'unparseable entry' };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'prevHash mismatch' };
    }
    const expected = computeEntryHash(entry, prevHash);
    if (entry.hash !== expected) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'hash mismatch' };
    }
    prevHash = entry.hash;
  }
  return { valid: true, entries: lines.length, brokenAt: null, reason: null };
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

module.exports = { audit, queryAuditLog, verifyAuditLog, redactSensitive };
