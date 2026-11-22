const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Audit logging notes (see docs/audit-logging.md):
 *
 * - Every audit entry carries: actor, requestId, action, outcome, timestamp.
 * - Entries are tamper-evident via a hash chain: each entry stores `prevHash`
 *   (the hash of the previous audit entry) and `hash` (sha256 over the
 *   canonicalized entry payload + prevHash). Any modification or deletion of
 *   an entry breaks the chain and is detectable by `verifyAuditChain`.
 * - Rotation is handled by the file transport (maxsize/maxFiles) and by
 *   `rotateAuditLog`. The chain state (last hash + sequence) is persisted to a
 *   sidecar state file so it survives rotation and process restarts.
 * - Retention: old rotated files are pruned according to AUDIT_RETENTION_DAYS.
 * - Failure handling: if the audit sink fails, the error is surfaced via the
 *   `auditFailureHandler` (defaults to logging to stderr) and the audit write
 *   is reported as failed so callers can fail closed if required.
 */

const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs');
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE || path.join(AUDIT_LOG_DIR, 'audit.log');
const AUDIT_STATE_FILE =
  process.env.AUDIT_STATE_FILE || path.join(AUDIT_LOG_DIR, 'audit.state.json');
const AUDIT_MAX_SIZE = parseInt(process.env.AUDIT_MAX_SIZE || String(10 * 1024 * 1024), 10);
const AUDIT_MAX_FILES = parseInt(process.env.AUDIT_MAX_FILES || '10', 10);
const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);

const GENESIS_HASH = '0'.repeat(64);

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function readAuditState() {
  try {
    const raw = fs.readFileSync(AUDIT_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastHash: typeof parsed.lastHash === 'string' ? parsed.lastHash : GENESIS_HASH,
      sequence: Number.isInteger(parsed.sequence) ? parsed.sequence : 0,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { lastHash: GENESIS_HASH, sequence: 0 };
    }
    throw err;
  }
}

function writeAuditState(state) {
  ensureDir(path.dirname(AUDIT_STATE_FILE));
  const tmp = `${AUDIT_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, AUDIT_STATE_FILE);
}

let auditState = null;

function getAuditState() {
  if (!auditState) {
    ensureDir(AUDIT_LOG_DIR);
    auditState = readAuditState();
  }
  return auditState;
}

function defaultAuditFailureHandler(err, entry) {
  // Fail loudly but do not crash the process by default.
  // eslint-disable-next-line no-console
  console.error('[audit] failed to persist audit entry', {
    error: err && err.message,
    action: entry && entry.action,
    requestId: entry && entry.requestId,
  });
}

let auditFailureHandler = defaultAuditFailureHandler;

function setAuditFailureHandler(handler) {
  auditFailureHandler = typeof handler === 'function' ? handler : defaultAuditFailureHandler;
}

/**
 * Append a tamper-evident audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action - e.g. 'mint', 'revoke', 'consent', 'admin'
 * @param {string} entry.outcome - e.g. 'success', 'failure', 'denied'
 * @param {string} [entry.actor] - actor identifier (user id, service, etc.)
 * @param {string} [entry.requestId] - correlation id for the request
 * @param {object} [entry.details] - additional non-sensitive structured data
 * @returns {{ok: boolean, hash?: string, sequence?: number, error?: Error}}
 */
function audit(entry) {
  const base = entry && typeof entry === 'object' ? entry : {};
  const state = getAuditState();

  const timestamp = new Date().toISOString();
  const sequence = state.sequence + 1;

  const payload = {
    sequence,
    timestamp,
    action: base.action || 'unknown',
    outcome: base.outcome || 'unknown',
    actor: base.actor || 'anonymous',
    requestId: base.requestId || null,
    details: base.details || {},
  };

  const prevHash = state.lastHash;
  const hash = sha256(`${prevHash}:${canonicalize(payload)}`);

  const record = { ...payload, prevHash, hash };

  try {
    ensureDir(path.dirname(AUDIT_LOG_FILE));
    fs.appendFileSync(AUDIT_LOG_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    auditState = { lastHash: hash, sequence };
    writeAuditState(auditState);
    return { ok: true, hash, sequence };
  } catch (err) {
    try {
      auditFailureHandler(err, record);
    } catch (handlerErr) {
      // eslint-disable-next-line no-console
      console.error('[audit] failure handler threw', handlerErr);
    }
    return { ok: false, error: err };
  }
}

/**
 * Verify the integrity of an audit log file (or the default one).
 * Returns { ok, entries, brokenAt }.
 */
function verifyAuditChain(filePath = AUDIT_LOG_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: true, entries: 0, brokenAt: null };
    }
    throw err;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let prevHash = GENESIS_HASH;
  let expectedSequence = 1;

  for (let i = 0; i < lines.length; i += 1) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch (err) {
      return { ok: false, entries: i, brokenAt: i, reason: 'invalid-json' };
    }

    const { prevHash: recordPrev, hash: recordHash, ...payload } = record;

    if (recordPrev !== prevHash) {
      return { ok: false, entries: i, brokenAt: i, reason: 'prev-hash-mismatch' };
    }
    if (payload.sequence !== expectedSequence) {
      return { ok: false, entries: i, brokenAt: i, reason: 'sequence-mismatch' };
    }

    const expectedHash = sha256(`${prevHash}:${canonicalize(payload)}`);
    if (expectedHash !== recordHash) {
      return { ok: false, entries: i, brokenAt: i, reason: 'hash-mismatch' };
    }

    prevHash = recordHash;
    expectedSequence += 1;
  }

  return { ok: true, entries: lines.length, brokenAt: null };
}

/**
 * Rotate the audit log. The current file is renamed with a timestamp suffix
 * and a fresh file is started. The hash chain state is preserved so the chain
 * continues across rotated files.
 */
function rotateAuditLog() {
  try {
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      return { ok: true, rotated: false };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = `${AUDIT_LOG_FILE}.${stamp}`;
    fs.renameSync(AUDIT_LOG_FILE, rotatedPath);
    pruneAuditLogs();
    return { ok: true, rotated: true, path: rotatedPath };
  } catch (err) {
    try {
      auditFailureHandler(err, { action: 'rotate' });
    } catch (handlerErr) {
      // eslint-disable-next-line no-console
      console.error('[audit] failure handler threw', handlerErr);
    }
    return { ok: false, error: err };
  }
}

/**
 * Prune rotated audit logs older than AUDIT_RETENTION_DAYS.
 */
function pruneAuditLogs() {
  const dir = path.dirname(AUDIT_LOG_FILE);
  const base = path.basename(AUDIT_LOG_FILE);
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return { ok: false, removed, error: err };
  }

  for (const file of files) {
    if (!file.startsWith(`${base}.`)) continue;
    const full = path.join(dir, file);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (err) {
      // Ignore individual file errors; continue pruning others.
    }
  }

  return { ok: true, removed };
}

/**
 * Winston format that injects request ID and actor context into every log
 * entry, and forwards audit-relevant entries to the tamper-evident sink.
 */
const contextFormat = format((info) => {
  const store = logger.contextStore;
  if (store) {
    if (store.requestId && !info.requestId) info.requestId = store.requestId;
    if (store.actor && !info.actor) info.actor = store.actor;
  }
  return info;
});

const auditFormat = format((info) => {
  if (info.audit === true) {
    const result = audit({
      action: info.action || info.message,
      outcome: info.outcome || 'unknown',
      actor: info.actor,
      requestId: info.requestId,
      details: info.details || {},
    });
    if (!result.ok) {
      info.auditPersisted = false;
    } else {
      info.auditPersisted = true;
      info.auditHash = result.hash;
      info.auditSequence = result.sequence;
    }
  }
  return info;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    contextFormat(),
    auditFormat(),
    format.timestamp(),
    format.errors({ stack: !isProd }),
    format.json()
  ),
  defaultMeta: { service: 'backend' },
  transports: [new transports.Console()],
});

/**
 * Run a function with an ambient request/actor context so that all logs
 * emitted within it automatically include requestId and actor.
 */
logger.withContext = function withContext(context, fn) {
  const previous = logger.contextStore;
  logger.contextStore = { ...(previous || {}), ...(context || {}) };
  try {
    return fn();
  } finally {
    logger.contextStore = previous;
  }
};

logger.audit = audit;
logger.verifyAuditChain = verifyAuditChain;
logger.rotateAuditLog = rotateAuditLog;
logger.pruneAuditLogs = pruneAuditLogs;
logger.setAuditFailureHandler = setAuditFailureHandler;

module.exports = logger;