const request = require('supertest');
const app = require('../src/app');
const health = require('../src/health');

describe('Health check', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /health returns degraded when Soroban is unhealthy', async () => {
    health.setSorobanHealthy(false);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    health.setSorobanHealthy(true);
  });
});

describe('Auth routes', () => {
  it('POST /auth/sep10 requires public_key', async () => {
    const res = await request(app).post('/auth/sep10').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(JSON.stringify(res.body.details)).toMatch(/public_key/);
  });

  it('POST /auth/sep10 rejects invalid key', async () => {
    const res = await request(app).post('/auth/sep10').send({ public_key: 'not-a-key' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/verify requires transaction and nonce', async () => {
    const res = await request(app).post('/auth/verify').send({});
    expect(res.status).toBe(400);
  });
});

describe('Vaccination routes', () => {
  it('POST /vaccination/issue requires auth', async () => {
    const res = await request(app).post('/vaccination/issue').send({});
    expect(res.status).toBe(401);
  });

  it('GET /vaccination/:wallet requires auth', async () => {
    const res = await request(app).get('/vaccination/GABC');
    expect(res.status).toBe(401);
  });
});

describe('Verify route', () => {
  it('GET /verify/:wallet rejects invalid address', async () => {
    const res = await request(app).get('/verify/invalid-address');
    expect(res.status).toBe(400);
  });
});

describe('Proxy header validation and client IP derivation', () => {
  const { getClientIp } = require('../src/middleware/clientIp');

  function makeReq({ socketAddress, headers = {} }) {
    return {
      socket: { remoteAddress: socketAddress },
      headers,
      ip: socketAddress,
    };
  }

  it('derives the socket address for direct (non-proxied) requests', () => {
    const req = makeReq({
      socketAddress: '203.0.113.10',
      headers: { 'x-forwarded-for': '198.51.100.99' },
    });
    expect(getClientIp(req)).toBe('203.0.113.10');
  });

  it('derives the client identity from trusted proxy headers', () => {
    const req = makeReq({
      socketAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '198.51.100.42, 10.0.0.5' },
    });
    expect(getClientIp(req, { trustedProxies: ['10.0.0.5'] })).toBe('198.51.100.42');
  });

  it('ignores spoofed forwarded headers from untrusted peers', () => {
    const req = makeReq({
      socketAddress: '203.0.113.10',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(getClientIp(req, { trustedProxies: ['10.0.0.5'] })).toBe('203.0.113.10');
  });

  it('does not let spoofed forwarded headers bypass rate limits', async () => {
    const spoofed = { 'x-forwarded-for': '1.2.3.4' };
    let lastStatus = 200;
    for (let i = 0; i < 50; i += 1) {
      const res = await request(app).get('/health').set(spoofed);
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('attributes audit entries to the derived client identity', () => {
    const req = makeReq({
      socketAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '198.51.100.42, 10.0.0.5' },
    });
    const identity = getClientIp(req, { trustedProxies: ['10.0.0.5'] });
    expect(identity).not.toBe('10.0.0.5');
    expect(identity).toBe('198.51.100.42');
  });
});