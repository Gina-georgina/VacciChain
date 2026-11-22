const express = require('express');
const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { adminAuthMiddleware } = require('../middleware/auth');
const { queryAuditLog, audit } = require('../middleware/auditLog');
const { insertApiKey, listApiKeys, revokeApiKey, updateApiKeyScopes } = require('../indexer/db');
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
 * POST /admin/issuers
 * Body: { address: string }
 * Authorizes a new issuer on-chain via add_issuer contract call.
 */
router.post('/issuers', adminAuthMiddleware, adminOnly, validate(addIssuerSchema), async (req, res) => {
  const { address } = req.body;

  try {
    const result = await addIssuer(address);
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'success', meta: { address } });
    res.status(201).json({ address, authorized: true, hash: result.hash });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'admin.add_issuer', result: 'failure', meta: { address, error: err.message } });
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

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

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return [];
  if (!Array.isArray(scopes)) return null;
  const cleaned = scopes
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

/**
 * POST /admin/api-keys
 * Body: { label: string, scopes?: string[] }
 *
 * Provisions a new verifier API key. Only the SHA-256 hash of the key is
 * persisted; the raw key is returned exactly once in the response.
 */
router.post('/api-keys', adminAuthMiddleware, adminOnly, validate(createApiKeySchema), (req, res) => {
  const { label } = req.body;
  const scopes = normalizeScopes(req.body.scopes);
  if (scopes === null) {
    return res.status(400).json({ error: 'scopes must be an array of strings' });
  }

  const rawKey  = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const id      = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    insertApiKey({
      id,
      key_hash: keyHash,
      label: label.trim(),
      scopes,
      created_at: createdAt,
      rotated_from: null,
    });
    audit({ actor: req.user.wallet, action: 'api_key.create', target: id, result: 'success', meta: { label: label.trim(), scopes } });
    res.status(201).json({ id, label: label.trim(), scopes, created_at: createdAt, key: rawKey });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.create', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

router.get('/api-keys', adminAuthMiddleware, adminOnly, (_req, res) => {
  res.json(listApiKeys());
});

/**
 * POST /admin/api-keys/:id/rotate
 *
 * Issues a replacement key for an existing (non-revoked) key. The old record
 * is revoked and linked to the new one via rotated_from; the new raw key is
 * returned exactly once.
 */
router.post('/api-keys/:id/rotate', adminAuthMiddleware, adminOnly, (req, res) => {
  const oldId = req.params.id;
  const existing = listApiKeys().find((k) => k.id === oldId);
  if (!existing) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: 'not found' } });
    return res.status(404).json({ error: 'API key not found' });
  }
  if (existing.revoked_at) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: 'already revoked' } });
    return res.status(409).json({ error: 'API key already revoked' });
  }

  const rawKey  = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const newId   = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    insertApiKey({
      id: newId,
      key_hash: keyHash,
      label: existing.label,
      scopes: existing.scopes || [],
      created_at: createdAt,
      rotated_from: oldId,
    });
    revokeApiKey(oldId);
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'success', meta: { new_id: newId } });
    res.status(201).json({
      id: newId,
      label: existing.label,
      scopes: existing.scopes || [],
      created_at: createdAt,
      rotated_from: oldId,
      key: rawKey,
    });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.rotate', target: oldId, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/api-keys/:id/scopes
 * Body: { scopes: string[] }
 *
 * Replaces the scope set of an existing, non-revoked key.
 */
router.patch('/api-keys/:id/scopes', adminAuthMiddleware, adminOnly, (req, res) => {
  const id = req.params.id;
  const scopes = normalizeScopes(req.body.scopes);
  if (scopes === null || scopes.length === 0) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'invalid scopes' } });
    return res.status(400).json({ error: 'scopes must be a non-empty array of strings' });
  }

  const existing = listApiKeys().find((k) => k.id === id);
  if (!existing) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'not found' } });
    return res.status(404).json({ error: 'API key not found' });
  }
  if (existing.revoked_at) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: 'already revoked' } });
    return res.status(409).json({ error: 'API key already revoked' });
  }

  try {
    updateApiKeyScopes(id, scopes);
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'success', meta: { scopes } });
    res.json({ id, scopes });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.scope', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:id', adminAuthMiddleware, adminOnly, (req, res) => {
  const id = req.params.id;
  try {
    revokeApiKey(id);
    audit({ actor: req.user.wallet, action: 'api_key.revoke', target: id, result: 'success' });
    res.json({ revoked: true });
  } catch (err) {
    audit({ actor: req.user.wallet, action: 'api_key.revoke', target: id, result: 'failure', meta: { error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

// ── JWT key rotation ──────────────────────────────────────────────────────────

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
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-sig proposal management ─────────────────────────────────────────────

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
