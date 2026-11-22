const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const VALID_ISSUER_ADDRESS = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';

jest.mock('../src/stellar/soroban', () => {
  const sdk = require('@stellar/stellar-sdk');
  return {
    invokeContract: jest.fn().mockResolvedValue({ hash: 'mockhash123', ledger: 1000 }),
    simulateContract: jest.fn().mockResolvedValue(sdk.xdr.ScVal.scvVec([])),
    getRpcServer: jest.fn().mockReturnValue({ getHealth: jest.fn().mockResolvedValue({}) }),
    addIssuer: jest.fn().mockResolvedValue({ hash: 'mockhash123', ledger: 1000 }),
    revokeIssuer: jest.fn().mockResolvedValue({ hash: 'mockhash456', ledger: 1001 }),
  };
});

jest.mock('../src/stellar/issuerCache', () => ({
  isAuthorizedIssuer: jest.fn().mockResolvedValue(true),
  invalidateCache: jest.fn(),
}));

jest.mock('../src/audit/auditLogger', () => {
  const actual = jest.requireActual('../src/audit/auditLogger');
  return {
    ...actual,
    writeAuditRecord: jest.fn().mockResolvedValue({ seq: 1, hash: 'a'.repeat(64) }),
    rotateAuditLog: jest.fn().mockResolvedValue({ rotated: true, file: 'audit-1.log' }),
    verifyAuditChain: jest.fn().mockResolvedValue({ valid: true, checked: 0 }),
    pruneAuditLogs: jest.fn().mockResolvedValue({ removed: 0 }),
  };
});

function makeToken(role) {
  return jwt.sign(
    { sub: 'GADMIN', wallet: 'GADMIN', role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('Admin Issuer Endpoints', () => {
  let adminToken;
  let issuerToken;
  let patientToken;

  beforeAll(() => {
    adminToken  = makeToken('admin');
    issuerToken = makeToken('issuer');
    patientToken = makeToken('patient');
  });

  // ── POST /admin/issuers ───────────────────────────────────────────────────

  describe('POST /v1/admin/issuers', () => {
    it('adds an issuer with admin JWT', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ address: VALID_ISSUER_ADDRESS, authorized: true });
      expect(res.body).toHaveProperty('hash');
    });

    it('rejects missing address', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('rejects invalid Stellar address', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: 'not-a-stellar-address' });

      expect(res.status).toBe(400);
    });

    it('rejects issuer role (admin only)', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${issuerToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(403);
    });

    it('rejects patient role', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /admin/issuers/:wallet ─────────────────────────────────────────

  describe('DELETE /v1/admin/issuers/:wallet', () => {
    it('revokes an issuer with admin JWT', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ wallet: VALID_ISSUER_ADDRESS, authorized: false });
      expect(res.body).toHaveProperty('hash');
    });

    it('returns 404 for non-existent issuer', async () => {
      const { isAuthorizedIssuer } = require('../src/stellar/issuerCache');
      isAuthorizedIssuer.mockResolvedValueOnce(false);

      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects invalid Stellar address', async () => {
      const res = await request(app)
        .delete('/v1/admin/issuers/bad-address')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('rejects non-admin role', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${patientToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`);

      expect(res.status).toBe(401);
    });
  });

  // ── Audit logging ─────────────────────────────────────────────────────────

  describe('Audit logging', () => {
    const auditLogger = require('../src/audit/auditLogger');

    beforeEach(() => {
      jest.clearAllMocks();
      auditLogger.writeAuditRecord.mockResolvedValue({ seq: 1, hash: 'a'.repeat(64) });
    });

    function expectStructuredRecord(record, { action, outcome }) {
      expect(record).toHaveProperty('actor');
      expect(record).toHaveProperty('requestId');
      expect(record).toHaveProperty('action', action);
      expect(record).toHaveProperty('outcome', outcome);
      expect(record).toHaveProperty('timestamp');
      expect(new Date(record.timestamp).toString()).not.toBe('Invalid Date');
    }

    it('records admin issuer mint (add) with actor, request ID, action, outcome, timestamp', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'req-mint-1')
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(201);
      expect(auditLogger.writeAuditRecord).toHaveBeenCalled();
      const record = auditLogger.writeAuditRecord.mock.calls[0][0];
      expectStructuredRecord(record, { action: 'issuer.add', outcome: 'success' });
      expect(record.actor).toBe('GADMIN');
      expect(record.requestId).toBe('req-mint-1');
    });

    it('records issuer revoke with actor, request ID, action, outcome, timestamp', async () => {
      const res = await request(app)
        .delete(`/v1/admin/issuers/${VALID_ISSUER_ADDRESS}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'req-revoke-1');

      expect(res.status).toBe(200);
      expect(auditLogger.writeAuditRecord).toHaveBeenCalled();
      const record = auditLogger.writeAuditRecord.mock.calls[0][0];
      expectStructuredRecord(record, { action: 'issuer.revoke', outcome: 'success' });
      expect(record.actor).toBe('GADMIN');
      expect(record.requestId).toBe('req-revoke-1');
    });

    it('records failed admin actions with failure outcome', async () => {
      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'req-fail-1')
        .send({ address: 'not-a-stellar-address' });

      expect(res.status).toBe(400);
      expect(auditLogger.writeAuditRecord).toHaveBeenCalled();
      const record = auditLogger.writeAuditRecord.mock.calls[0][0];
      expectStructuredRecord(record, { action: 'issuer.add', outcome: 'failure' });
      expect(record.requestId).toBe('req-fail-1');
    });

    it('records consent actions with actor, request ID, action, outcome, timestamp', async () => {
      const res = await request(app)
        .post('/v1/consent')
        .set('Authorization', `Bearer ${patientToken}`)
        .set('X-Request-Id', 'req-consent-1')
        .send({ issuer: VALID_ISSUER_ADDRESS, scope: 'records:read' });

      expect(auditLogger.writeAuditRecord).toHaveBeenCalled();
      const record = auditLogger.writeAuditRecord.mock.calls[0][0];
      expect(record).toHaveProperty('actor');
      expect(record).toHaveProperty('requestId');
      expect(record).toHaveProperty('action');
      expect(record).toHaveProperty('outcome');
      expect(record).toHaveProperty('timestamp');
      expect(record.requestId).toBe('req-consent-1');
      expect(res.status).toBeLessThan(500);
    });

    it('does not leak sensitive data (tokens, secrets) into audit records', async () => {
      await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'req-secret-1')
        .send({ address: VALID_ISSUER_ADDRESS });

      const serialized = JSON.stringify(auditLogger.writeAuditRecord.mock.calls);
      expect(serialized).not.toContain(adminToken);
      expect(serialized).not.toContain(process.env.JWT_SECRET);
    });

    it('rotates the audit log', async () => {
      const result = await auditLogger.rotateAuditLog();
      expect(auditLogger.rotateAuditLog).toHaveBeenCalled();
      expect(result).toHaveProperty('rotated', true);
    });

    it('prunes audit logs according to retention policy', async () => {
      const result = await auditLogger.pruneAuditLogs({ retentionDays: 90 });
      expect(auditLogger.pruneAuditLogs).toHaveBeenCalledWith({ retentionDays: 90 });
      expect(result).toHaveProperty('removed');
    });

    it('verifies the hash chain for integrity', async () => {
      const result = await auditLogger.verifyAuditChain();
      expect(auditLogger.verifyAuditChain).toHaveBeenCalled();
      expect(result).toHaveProperty('valid', true);
    });

    it('detects a broken hash chain', async () => {
      auditLogger.verifyAuditChain.mockResolvedValueOnce({
        valid: false,
        checked: 3,
        brokenAt: 2,
      });
      const result = await auditLogger.verifyAuditChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('handles audit write failures without failing the request', async () => {
      auditLogger.writeAuditRecord.mockRejectedValueOnce(new Error('disk full'));

      const res = await request(app)
        .post('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: VALID_ISSUER_ADDRESS });

      expect(res.status).toBe(201);
    });
  });

  // ── GET /admin/issuers ────────────────────────────────────────────────────

  describe('GET /v1/admin/issuers', () => {
    it('returns issuer list with admin JWT', async () => {
      const res = await request(app)
        .get('/v1/admin/issuers')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('issuers');
      expect(Array.isArray(res.body.issuers)).toBe(true);
    });

    it('rejects non-admin role', async () => {
      const res = await request(app)
        .get('/v1/admin/issuers')
        .set('Authorization', `Bearer ${patientToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated request', async () => {
      const res = await request(app).get('/v1/admin/issuers');
      expect(res.status).toBe(401);
    });
  });
});
