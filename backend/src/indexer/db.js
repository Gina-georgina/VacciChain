/**
 * SQLite-backed event store using sql.js (pure WASM — no native build required).
 * The DB is loaded from disk on init and flushed to disk after every write.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let dbPath = null;

// ── Persistence / concurrency controls ───────────────────────────────────────
// The store is a single in-memory sql.js database flushed to disk. To make it
// safe for the multi-writer deployment analysis (backlog #52) we serialize all
// writes through an in-process lock, write atomically (temp file + rename) and
// keep a bounded set of timestamped backups so durability/failover can be
// exercised and validated.

const LOCK_TIMEOUT_MS = 5000;
const BACKUP_DIR_SUFFIX = '.backups';
const MAX_BACKUPS = 5;

let writeLock = Promise.resolve();
let lockDepth = 0;
let migrationHooks = [];

/** Run `fn` while holding the exclusive write lock (serializes writers). */
async function withWriteLock(fn) {
  const previous = writeLock;
  let release;
  writeLock = new Promise((resolve) => { release = resolve; });

  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), LOCK_TIMEOUT_MS)),
  ]);
  if (!acquired) {
    release();
    throw new Error('Timed out acquiring database write lock');
  }

  lockDepth += 1;
  try {
    return await fn();
  } finally {
    lockDepth -= 1;
    release();
  }
}

/** True when the current call stack holds the write lock. */
function isLocked() {
  return lockDepth > 0;
}

function backupDir() {
  return dbPath ? `${dbPath}${BACKUP_DIR_SUFFIX}` : null;
}

/** Atomically persist the in-memory DB to disk (temp file + rename). */
function flush() {
  if (!db || !dbPath) return;
  const data = Buffer.from(db.export());
  const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, dbPath);
}

/** Persist a timestamped backup copy and prune old ones. */
function backup() {
  if (!db || !dbPath) return null;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `backup-${Date.now()}.sqlite`);
  fs.writeFileSync(target, Buffer.from(db.export()));

  const backups = fs.readdirSync(dir)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.sqlite'))
    .sort();
  while (backups.length > MAX_BACKUPS) {
    fs.unlinkSync(path.join(dir, backups.shift()));
  }
  return target;
}

/** Register a migration hook: fn(db) => void, run once on init. */
function registerMigration(fn) {
  if (typeof fn === 'function') migrationHooks.push(fn);
}

function runMigrations() {
  for (const hook of migrationHooks) hook(db);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    ledger      INTEGER NOT NULL,
    timestamp   INTEGER NOT NULL,
    contract_id TEXT NOT NULL,
    payload     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger);

  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    key_hash    TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS patient_consent (
    wallet       TEXT PRIMARY KEY,
    consented_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS issuer_applications (
    id             TEXT PRIMARY KEY,
    wallet         TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    license_number TEXT NOT NULL,
    country        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    submitted_at   TEXT NOT NULL,
    reviewed_at    TEXT,
    reviewer_note  TEXT
  );
`;

/** Persist in-memory DB to disk. */
function flush() {
  if (!db || !dbPath) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/** Initialize (or load) the database. */
async function initDb(filePath) {
  dbPath = filePath;
  const SQL = await initSqlJs();

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  db.run(SCHEMA);
  runMigrations();
  flush();
  return db;
}

/**
 * Upsert a batch of events. Deduplicates by id (PRIMARY KEY conflict = ignore).
 * @param {Array<{id, event_type, ledger, timestamp, contract_id, payload}>} events
 */
async function upsertEvents(events) {
  if (!events.length) return;
  await withWriteLock(() => {
    db.run('BEGIN');
    try {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO events (id, event_type, ledger, timestamp, contract_id, payload) VALUES (?,?,?,?,?,?)'
      );
      for (const e of events) {
        stmt.run([e.id, e.event_type, e.ledger, e.timestamp, e.contract_id, JSON.stringify(e.payload)]);
      }
      stmt.free();
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
    flush();
  });
}

/**
 * Query events with optional filters.
 * @param {{ event_type?: string, limit?: number, offset?: number }} opts
 */
function queryEvents({ event_type, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM events';
  const params = [];
  if (event_type) {
    sql += ' WHERE event_type = ?';
    params.push(event_type);
  }
  sql += ' ORDER BY ledger DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = db.exec(sql, params);
  if (!results.length) return [];

  const { columns, values } = results[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.payload = JSON.parse(obj.payload);
    return obj;
  });
}

/** Return the highest ledger sequence we've indexed (0 if none). */
function getLatestLedger() {
  const res = db.exec('SELECT MAX(ledger) as max_ledger FROM events');
  if (!res.length || res[0].values[0][0] == null) return 0;
  return res[0].values[0][0];
}

// ── API key CRUD ──────────────────────────────────────────────────────────────

async function insertApiKey({ id, key_hash, label, created_at }) {
  await withWriteLock(() => {
    db.run(
      'INSERT INTO api_keys (id, key_hash, label, created_at, revoked) VALUES (?,?,?,?,0)',
      [id, key_hash, label, created_at]
    );
    flush();
  });
}

function getApiKeyByHash(key_hash) {
  const res = db.exec('SELECT * FROM api_keys WHERE key_hash = ?', [key_hash]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function listApiKeys() {
  const res = db.exec('SELECT id, label, created_at, revoked FROM api_keys ORDER BY created_at DESC');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

async function revokeApiKey(id) {
  await withWriteLock(() => {
    db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
    flush();
  });
}

module.exports = {
  initDb,
  upsertEvents,
  queryEvents,
  getLatestLedger,
  insertApiKey,
  getApiKeyByHash,
  listApiKeys,
  revokeApiKey,
  getConsent,
  recordConsent,
  hasConsented,
  insertIssuerApplication,
  getIssuerApplication,
  listIssuerApplications,
  updateIssuerApplicationStatus,
  // persistence / concurrency helpers (backlog #52)
  withWriteLock,
  isLocked,
  flush,
  backup,
  registerMigration,
};

// ── Patient consent ───────────────────────────────────────────────────────────

async function recordConsent(wallet) {
  await withWriteLock(() => {
    db.run(
      'INSERT OR IGNORE INTO patient_consent (wallet, consented_at) VALUES (?, ?)',
      [wallet, new Date().toISOString()]
    );
    flush();
  });
}

function getConsent(wallet) {
  const res = db.exec('SELECT wallet, consented_at FROM patient_consent WHERE wallet = ?', [wallet]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function hasConsented(wallet) {
  return !!getConsent(wallet);
}

// ── Issuer onboarding applications ───────────────────────────────────────────

async function insertIssuerApplication({ id, wallet, name, license_number, country, submitted_at }) {
  await withWriteLock(() => {
    db.run(
      `INSERT INTO issuer_applications (id, wallet, name, license_number, country, status, submitted_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      [id, wallet, name, license_number, country, submitted_at]
    );
    flush();
  });
}

function getIssuerApplication(id) {
  const res = db.exec('SELECT * FROM issuer_applications WHERE id = ?', [id]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

function listIssuerApplications({ status } = {}) {
  let sql = 'SELECT * FROM issuer_applications';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY submitted_at DESC';
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

async function updateIssuerApplicationStatus(id, { status, reviewer_note }) {
  await withWriteLock(() => {
    db.run(
      'UPDATE issuer_applications SET status = ?, reviewed_at = ?, reviewer_note = ? WHERE id = ?',
      [status, new Date().toISOString(), reviewer_note || null, id]
    );
    flush();
  });
}
