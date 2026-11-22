/**
 * Polls the Soroban RPC for contract events and stores them in SQLite.
 *
 * Soroban RPC: getEvents({ startLedger, filters: [{ contractIds, topics }] })
 * Indexed event types: VaccinationMinted, IssuerAdded, IssuerRevoked
 */
const StellarSdk = require('@stellar/stellar-sdk');
const { upsertEvents, getLatestLedger } = require('./db');
const { invalidateCache } = require('../stellar/issuerCache');


const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VACCINATIONS_CONTRACT_ID;

// Map Soroban symbol_short event topic names to our internal event_type strings
const TOPIC_MAP = {
  minted:  'VaccinationMinted',
  iss_add: 'IssuerAdded',
  iss_rev: 'IssuerRevoked',
};

// Maximum number of events processed per batch before yielding to the event loop.
const BATCH_SIZE = Number(process.env.INDEXER_BATCH_SIZE) || 50;

let timer = null;
let running = false;

// Observable job status snapshot for the polling job.
const jobStatus = {
  lastRunAt: null,
  lastDurationMs: null,
  lastGetEventsMs: null,
  lastUpsertMs: null,
  lastEventCount: 0,
  lastBatchCount: 0,
  lastError: null,
  lastErrorAt: null,
  runs: 0,
  errors: 0,
};

function getJobStatus() {
  return { ...jobStatus };
}

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

/** Yield control back to the event loop so other handlers are not starved. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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

  // Prevent overlapping runs from piling up on the event loop.
  if (running) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[indexer] Previous poll still running — skipping this tick');
    }
    return;
  }

  running = true;
  const runStart = Date.now();
  jobStatus.lastRunAt = new Date(runStart).toISOString();
  jobStatus.lastEventCount = 0;
  jobStatus.lastBatchCount = 0;

  try {
    const rpc = getRpc();
    const startLedger = getLatestLedger() + 1;

    const getStart = Date.now();
    const response = await rpc.getEvents({
      startLedger,
      filters: [{ contractIds: [CONTRACT_ID] }],
    });
    jobStatus.lastGetEventsMs = Date.now() - getStart;

    const events = (response.events ?? [])
      .map(parseEvent)
      .filter(Boolean);

    jobStatus.lastEventCount = events.length;

    if (events.length) {
      let upsertMs = 0;

      // Process events in bounded batches, yielding between batches so the
      // event loop stays responsive for request handlers.
      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);

        const upsertStart = Date.now();
        upsertEvents(batch);
        upsertMs += Date.now() - upsertStart;

        // Invalidate issuer cache on relevant events
        for (const e of batch) {
          if ((e.event_type === 'IssuerRevoked' || e.event_type === 'IssuerAdded') && e.payload.issuer) {
            invalidateCache(e.payload.issuer);
            if (process.env.NODE_ENV !== 'test') {
              console.log(`[indexer] Invalidated cache for issuer: ${e.payload.issuer}`);
            }
          }
        }

        jobStatus.lastBatchCount += 1;

        // Yield to the event loop between batches (skip after the last one).
        if (i + BATCH_SIZE < events.length) {
          await yieldToEventLoop();
        }
      }

      jobStatus.lastUpsertMs = upsertMs;

      if (process.env.NODE_ENV !== 'test') {
        console.log(`[indexer] Stored ${events.length} new event(s) from ledger ${startLedger} in ${jobStatus.lastBatchCount} batch(es)`);
      }
    } else {
      jobStatus.lastUpsertMs = 0;
    }

    jobStatus.runs += 1;
  } catch (err) {
    jobStatus.errors += 1;
    jobStatus.lastError = err.message;
    jobStatus.lastErrorAt = new Date().toISOString();
    if (process.env.NODE_ENV !== 'test') {
      console.error('[indexer] Poll error:', err.message);
    }
  } finally {
    jobStatus.lastDurationMs = Date.now() - runStart;
    running = false;
  }
}

/**
 * Start the background polling loop.
 * @param {number} intervalMs
 */
function startPoller(intervalMs) {
  if (timer) return;
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

module.exports = { startPoller, stopPoller, poll, parseEvent, getJobStatus };
