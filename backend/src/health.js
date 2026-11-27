const config = require('./config');
const { getRpcServer } = require('./stellar/soroban');
const logger = require('./logger');

let sorobanHealthy = true;
let databaseHealthy = true;
let lastProbeAt = null;
let dbInitialized = false;

/**
 * Liveness status.
 *
 * Semantics: reports only whether the process itself is running and able to
 * serve requests. It intentionally does NOT reflect dependency state (database
 * or Soroban RPC), so orchestrators can restart a crashed/hung process without
 * cycling on temporary dependency outages. While this code is executing the
 * process is alive, so status is always 'ok'.
 */
function getLivenessStatus() {
  return {
    status: 'ok',
    uptime: Number(process.uptime().toFixed(3)),
  };
}

/**
 * Readiness status.
 *
 * Semantics: reports whether the service can serve traffic, which requires the
 * database and the required Soroban RPC endpoint to be reachable. Only
 * sanitized booleans are exposed — no URLs, keys, or error messages — so the
 * response never discloses secrets or internal details.
 */
function getReadinessStatus() {
  const ready = databaseHealthy && sorobanHealthy;
  return {
    status: ready ? 'ok' : 'degraded',
    ready,
    dependencies: {
      database: databaseHealthy,
      sorobanRpc: sorobanHealthy,
    },
    checks: {
      db: dbInitialized ? 'ok' : 'unavailable',
      soroban: sorobanHealthy ? 'ok' : 'unavailable',
    },
    uptime: Number(process.uptime().toFixed(3)),
    lastProbeAt: lastProbeAt ? lastProbeAt.toISOString() : null,
  };
}

/**
 * Backwards-compatible aggregate health status. Reports 'ok' only when all
 * required dependencies are healthy.
 */
function getHealthStatus() {
  return getReadinessStatus();
}

async function probeSorobanHealth() {
  try {
    await getRpcServer().getHealth();
    sorobanHealthy = true;
  } catch (error) {
    sorobanHealthy = false;
    logger.warn('Soroban health probe failed', {
      message: error.message,
      code: error.code,
    });
  } finally {
    lastProbeAt = new Date();
  }
}

async function probeDatabaseHealth() {
  try {
    // Lazy-require to avoid a hard dependency at module load time and to keep
    // the probe resilient if the DB module is unavailable.
    const db = require('./db');
    if (db && typeof db.healthCheck === 'function') {
      await db.healthCheck();
    } else if (db && typeof db.query === 'function') {
      await db.query('SELECT 1');
    }
    databaseHealthy = true;
  } catch (error) {
    databaseHealthy = false;
    logger.warn('Database health probe failed', {
      message: error.message,
      code: error.code,
    });
  } finally {
    lastProbeAt = new Date();
  }
}

async function probeDependencies() {
  await Promise.all([
    probeSorobanHealth(),
    probeDatabaseHealth(),
  ]);
}

function startHealthProbe() {
  // Run an initial probe immediately, then refresh at the configured interval.
  probeDependencies().catch((error) => {
    logger.error('Initial health probe failed', { message: error.message });
  });

  const interval = setInterval(() => {
    probeDependencies().catch((error) => {
      logger.error('Health probe failed', { message: error.message });
    });
  }, config.HEALTH_POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

function setSorobanHealthy(value) {
  sorobanHealthy = value;
  lastProbeAt = new Date();
}

function setDatabaseHealthy(value) {
  databaseHealthy = value;
  lastProbeAt = new Date();
}

function setDbInitialized(value) {
  dbInitialized = Boolean(value);
}

module.exports = {
  getLivenessStatus,
  getReadinessStatus,
  getHealthStatus,
  startHealthProbe,
  setSorobanHealthy,
  setDatabaseHealthy,
  setDbInitialized,
  _getLastProbeAt: () => lastProbeAt,
};