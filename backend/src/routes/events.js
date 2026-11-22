const express = require('express');
const { queryEvents } = require('../indexer/db');

const router = express.Router();

// Safe bounds for synchronous work in the request handler.
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_OFFSET = 1_000_000;
// Latency budget (ms) for a single events query. Queries exceeding this are logged.
const QUERY_LATENCY_BUDGET_MS = 100;
// Maximum number of rows fetched per bounded batch to avoid blocking the event loop.
const BATCH_SIZE = 100;

/**
 * Parse and clamp the limit query param to a safe maximum.
 */
function parseLimit(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Parse and validate the offset query param.
 */
function parseOffset(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, MAX_OFFSET);
}

/**
 * Fetch events in bounded batches so a large scan does not block the event loop.
 * Yields control back to the event loop between batches.
 */
async function fetchEventsInBatches({ event_type, limit, offset }) {
  const events = [];
  let remaining = limit;
  let cursor = offset;

  while (remaining > 0) {
    const batchLimit = Math.min(remaining, BATCH_SIZE);
    const batch = queryEvents({ event_type, limit: batchLimit, offset: cursor });

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    events.push(...batch);
    remaining -= batch.length;
    cursor += batch.length;

    // If the batch was not full, there are no more rows to fetch.
    if (batch.length < batchLimit) {
      break;
    }

    // Yield to the event loop between batches to keep handlers responsive.
    await new Promise((resolve) => setImmediate(resolve));
  }

  return events;
}

/**
 * GET /events
 * Query params: event_type, limit (max 500), offset
 */
router.get('/', async (req, res, next) => {
  const { event_type } = req.query;
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);

  const start = process.hrtime.bigint();
  try {
    const events = await fetchEventsInBatches({ event_type, limit, offset });

    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMs > QUERY_LATENCY_BUDGET_MS) {
      console.warn(
        `[events] query exceeded latency budget: ${elapsedMs.toFixed(1)}ms ` +
          `(budget ${QUERY_LATENCY_BUDGET_MS}ms, limit=${limit}, offset=${offset}, ` +
          `event_type=${event_type || 'any'})`
      );
    }

    res.json({ events, count: events.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;