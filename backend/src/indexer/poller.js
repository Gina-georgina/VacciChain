/**
 * Polls the Soroban RPC for contract events and stores them in SQLite.
 *
 * Soroban RPC: getEvents({ startLedger, filters: [{ contractIds, topics }] })
 * Indexed event types: VaccinationMinted, IssuerAdded, IssuerRevoked
 */
const StellarSdk = require('@stellar/stellar-sdk');
const {
  upsertEvents,
  getLatestLedger,
  getMigrationState,
  isLockContentionError,
} = require('./db');
const { invalidateCache } = require('../stellar/issuerCache');


const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VACCINATIONS_CONTRACT_ID;

// Map Soroban symbol_short event topic names to our internal event_type strings
const TOPIC_MAP = {
  minted:  'VaccinationMinted',
  iss_add: 'IssuerAdded',
  iss_rev: 'IssuerRevoked',
};

let timer = null;

// Retry configuration for lock contention / transient DB failures.
// Multiple backend tasks may poll concurrently; SQLite serialises writers, so
// a contended write surfaces as SQLITE_BUSY. We retry with backoff instead of
// dropping the batch (which would leave gaps in the index).
const MAX_WRITE_RETRIES = Number(process.env.INDEXER_WRITE_RETRIES || 5);
const BASE_RETRY_DELAY_MS = Number(process.env.INDEXER_RETRY_BASE_MS || 100);

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist a batch of events with retry-on-lock-contention.
 * Returns true if the batch was written, false if it was abandoned.
 */
async function persistEventsWithRetry(events) {
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
    try {
      upsertEvents(events);
      return true;
    } catch (err) {
      const contention = isLockContentionError(err);
      if (!contention || attempt === MAX_WRITE_RETRIES) {
        if (process.env.NODE_ENV !== 'test') {
          console.error(
            `[indexer] Failed to persist ${events.length} event(s) after ${attempt + 1} attempt(s):`,
            err.message
          );
        }
        return false;
      }
      // Exponential backoff with jitter to de-synchronise competing writers.
      const delay = BASE_RETRY_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(
          `[indexer] Lock contention writing events (attempt ${attempt + 1}/${MAX_WRITE_RETRIES}); retrying in ${delay}ms`
        );
      }
      await sleep(delay);
    }
  }
  return false;
}

/** Log the current schema/migration state so operators can detect drift after failover. */
function logMigrationState() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const state = getMigrationState();
    console.log(
      `[indexer] DB migration state: version=${state.version} applied=${state.applied} pending=${state.pending}`
    );
    if (state.pending > 0) {
      console.warn(
        `[indexer] ${state.pending} pending migration(s) detected — run migrations before scaling backend tasks`
      );
    }
  } catch (err) {
    console.error('[indexer] Unable to read migration state:', err.message);
  }
}

/** Parse a raw Soroban event into our storage shape. Returns null if unrecognised. */
function parseEvent(raw) {
  try {
    const topicVal = raw.topic?.[0];
    if (!topicVal) return null;

    // topic[0] is a ScVal symbol — extract the string value
    const topicStr = topicVal.value?.toString?.() ?? topicVal.toString();
    const event_type = TOPIC_MAP[topicStr];
    if (!event_type) return null;

    const parsed = {
      id: raw.id,
      event_type,
      ledger: raw.ledger,
      timestamp: raw.ledgerClosedAt
        ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000)
        : 0,
      contract_id: raw.contractId ?? CONTRACT_ID,
      payload: raw.value ?? {},
    };

    // Extract issuer address from topics for IssuerAdded/Revoked events
    if (parsed.event_type === 'IssuerAdded' || parsed.event_type === 'IssuerRevoked') {
      const issuerScVal = raw.topic?.[1];
      if (issuerScVal) {
        parsed.payload.issuer = StellarSdk.scValToNative(issuerScVal);
      }
    }

    return parsed;

  } catch {
    return null;
  }
}

async function poll() {
  if (!CONTRACT_ID) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[indexer] VACCINATIONS_CONTRACT_ID not set — skipping poll');
    }
    return;
  }

  try {
    const rpc = getRpc();
    const startLedger = getLatestLedger() + 1;

    const response = await rpc.getEvents({
      startLedger,
      filters: [{ contractIds: [CONTRACT_ID] }],
    });

    const events = (response.events ?? [])
      .map(parseEvent)
      .filter(Boolean);

    if (events.length) {
      const stored = await persistEventsWithRetry(events);
      if (!stored) {
        // Do not advance past this batch: the next poll re-reads from the same
        // startLedger so no events are lost when a write is abandoned.
        return;
      }
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[indexer] Stored ${events.length} new event(s) from ledger ${startLedger}`);
      }

      // Invalidate issuer cache on relevant events
      for (const e of events) {
        if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
          invalidateCache(e.payload.issuer);
          if (process.env.NODE_ENV !== 'test') {
            console.log(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
          }
        }
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[indexer] Poll error:', err.message);
    }
  }
}

/**
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
  logMigrationState();
  poll(); // immediate first run
  timer = setInterval(poll, intervalMs);
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[indexer] Polling every ${intervalMs}ms`);
  }
}

function stopPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startPoller, stopPoller, poll, parseEvent, persistEventsWithRetry, logMigrationState };
