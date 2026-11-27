const express = require('express');
const { queryEvents } = require('../indexer/db');

const router = express.Router();

/**
 * @swagger
 * /events:
 *   get:
 *     summary: Query indexed on-chain events
 *     tags:
 *       - Events
 *     parameters:
 *       - in: query
 *         name: event_type
 *         schema: { type: string }
 *         description: Filter by event type
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 500 }
 *         description: Max results (default 100)
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *         description: Offset for pagination
 *     responses:
 *       200:
 *         description: Events retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                 count:
 *                   type: integer
 */

/**
 * GET /events
 * Query params: event_type, limit (max 500), offset
 */
router.get('/', (req, res) => {
  const { event_type } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const events = queryEvents({ event_type, limit, offset });
  res.json({ events, count: events.length });
});

module.exports = router;
