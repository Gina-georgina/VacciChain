const express = require('express');
const { ERROR_CODES, sendError } = require('../errors');
const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware } = require('../middleware/auth');
const { queryAuditLog, audit } = require('../middleware/auditLog');
const { insertApiKey, listApiKeys, revokeApiKey } = require('../indexer/db');
const { rotateKey, reloadFromEnv } = require('../jwtKeys');
const { approveProposal, getProposal } = require('../middleware/multiSig');
const { isValidStellarPublicKey } = require('../middleware/wallet');
const { addIssuer, revokeIssuer, simulateContract } = require('../stellar/soroban');
const { isAuthorizedIssuer, invalidateCache } = require('../stellar/issuerCache');
const validate = require('../middleware/validate');
const { addIssuerSchema, createApiKeySchema, rotateJwtSchema, approveProposalSchema } = require('./schemas/admin.schemas');

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}



// ── Issuer management ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/issuers:
 *   post:
 *     summary: Authorize a new issuer on-chain
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *     responses:
 *       201:
 *         description: Issuer authorized
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 *   delete:
 *     summary: Revoke an issuer on-chain
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Issuer revoked
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 *   get:
 *     summary: List all authorized issuers
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Issuer list
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

/**
 * POST /admin/issuers
 * Body: { address: string }
 * Authorizes a new issuer on-chain via add_issuer contract call.
 */
router.post('/issuers', adminAuthMiddleware, adminOnly, validate(addIssuerSchema), async (req, res) => {
  const { address } = req.body;

  try {
    const result = await addIssuer(address);
    invalidateCache(address);
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'success', meta: { address } });
    res.status(201).json({ address, authorized: true, hash: result.hash });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'failure', meta: { address, error: err.message } });
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

/**
 * DELETE /admin/issuers/:wallet
 * Revokes an issuer on-chain via revoke_issuer contract call.
 */
router.delete('/issuers/:wallet', adminAuthMiddleware, adminOnly, async (req, res) => {
  const { wallet } = req.params;
  if (!isValidStellarPublicKey(wallet)) {
    return res.status(400).json({ error: 'Invalid Stellar public key' });
  }

  try {
    const authorized = await isAuthorizedIssuer(wallet);
    if (!authorized) {
      return res.status(404).json({ error: 'Issuer not found' });
    }

    const result = await revokeIssuer(wallet);
    invalidateCache(wallet);
    audit({ actor: req.user.wallet, action: 'admin.revoke_issuer', target: wallet, result: 'success', meta: { hash: result.hash } });
    res.json({ wallet, authorized: false, hash: result.hash });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'admin.revoke_issuer', target: wallet, result: 'failure', meta: { error: err.message } });
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

/**
 * GET /admin/issuers
 * Lists all authorized issuers by reading contract state.
 */
router.get('/issuers', adminAuthMiddleware, adminOnly, async (req, res) => {
  try {
    const retval = await simulateContract('list_issuers', []);
    // Contract returns a Vec of addresses; parse into an array of strings
    let issuers = [];
    if (retval && retval.switch().name === 'scvVec') {
      issuers = retval.vec().map((v) => StellarSdk.Address.fromScVal(v).toString());
    }
    res.json({ issuers });
  } catch (err) {
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/audit:
 *   get:
 *     summary: Query audit log entries
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Audit entries
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

/**
 * GET /admin/audit
 */
router.get('/audit', adminAuthMiddleware, adminOnly, (req, res) => {
  const { actor, from, to } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 1000);
  const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

  if (from && isNaN(new Date(from).getTime())) {
    return res.status(400).json({ error: 'Invalid "from" date' });
  }
  if (to && isNaN(new Date(to).getTime())) {
    return res.status(400).json({ error: 'Invalid "to" date' });
  }

  const entries = queryAuditLog({ actor, from, to });
  const page    = entries.slice(offset, offset + limit);
  res.json({ total: entries.length, offset, limit, entries: page });
});

// ── API key management ────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/api-keys:
 *   post:
 *     summary: Create a verifier API key
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - label
 *             properties:
 *               label:
 *                 type: string
 *     responses:
 *       201:
 *         description: API key created
 *   get:
 *     summary: List all API keys
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: API key list
 *   delete:
 *     summary: Revoke an API key
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: API key revoked
 */

/**
 * POST /admin/api-keys
 * Body: { label: string }
 */
router.post('/api-keys', adminAuthMiddleware, adminOnly, validate(createApiKeySchema), (req, res) => {
  const { label } = req.body;

  const rawKey  = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const id      = crypto.randomUUID();

  insertApiKey({ id, key_hash: keyHash, label: label.trim(), created_at: new Date().toISOString() });

  res.status(201).json({ id, label: label.trim(), key: rawKey });
});

router.get('/api-keys', adminAuthMiddleware, adminOnly, (_req, res) => {
  res.json(listApiKeys());
});

router.delete('/api-keys/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  revokeApiKey(req.params.id);
  res.json({ revoked: true });
});

// ── JWT key rotation ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/jwt/rotate:
 *   post:
 *     summary: Rotate the JWT signing key at runtime
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_secret:
 *                 type: string
 *               new_kid:
 *                 type: string
 *               reload_from_env:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Key rotated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin required
 */

/**
 * POST /admin/jwt/rotate
 *
 * Rotate the JWT signing key at runtime without a service restart.
 * The current key is demoted to "previous" (still accepted for verification
 * during the transition window). The new key is used for all future tokens.
 *
 * Body (option A — supply new secret directly):
 *   { new_secret: string, new_kid?: string }
 *
 * Body (option B — reload from environment, e.g. after secrets manager refresh):
 *   { reload_from_env: true }
 *
 * Requires admin role.
 */
router.post('/jwt/rotate', adminAuthMiddleware, adminOnly, validate(rotateJwtSchema), (req, res) => {
  const { new_secret, new_kid, reload_from_env } = req.body;

  try {
    if (reload_from_env) {
      reloadFromEnv();
      return res.json({ rotated: true, method: 'env_reload' });
    }

    rotateKey({ newSecret: new_secret, newKid: new_kid });
    res.json({ rotated: true, method: 'inline', kid: new_kid || 'auto' });
  } catch (err) {
    sendError(req, res, 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

// ── Multi-sig proposal management ─────────────────────────────────────────────

/**
 * @swagger
 * /admin/multisig/approve:
 *   post:
 *     summary: Approve a pending multi-sig proposal
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - proposal_id
 *             properties:
 *               proposal_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Proposal approval recorded
 *   get:
 *     summary: Get the current state of a proposal
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proposal state
 */

/**
 * POST /admin/multisig/approve
 * Body: { proposal_id: string }
 *
 * A registered key holder approves a pending multi-sig proposal.
 * Once MULTISIG_THRESHOLD approvals are collected the proposal is marked
 * "approved" and the initiator can re-submit the original request with
 * the proposal_id to execute it.
 */
router.post('/multisig/approve', adminAuthMiddleware, adminOnly, validate(approveProposalSchema), (req, res) => {
  const { proposal_id } = req.body;

  try {
    const proposal = approveProposal(proposal_id, req.user.wallet);
    res.json({
      proposal_id: proposal.id,
      operation: proposal.operation,
      approvals: proposal.approvals.size,
      status: proposal.status,
      expires_at: new Date(proposal.expiresAt).toISOString(),
    });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('expired') ? 410
      : err.message.includes('not a registered') ? 403
      : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /admin/multisig/proposals/:id
 * Returns the current state of a proposal (approval count, status, expiry).
 */
router.get('/multisig/proposals/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  const proposal = getProposal(req.params.id);
  if (!proposal) {
    return res.status(404).json({ error: 'Proposal not found or expired' });
  }
  res.json({
    proposal_id: proposal.id,
    operation: proposal.operation,
    initiator: proposal.initiator,
    approvals: proposal.approvals.size,
    status: proposal.status,
    expires_at: new Date(proposal.expiresAt).toISOString(),
  });
});

module.exports = router;
