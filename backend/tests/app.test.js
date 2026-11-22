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

describe('API deprecation and sunset policy', () => {
  const expectDeprecationHeaders = (res, successorPath) => {
    expect(res.headers.deprecation).toBeDefined();
    expect(res.headers.sunset).toBeDefined();
    expect(Number.isNaN(Date.parse(res.headers.sunset))).toBe(false);
    expect(res.headers.link).toBeDefined();
    expect(res.headers.link).toMatch(/rel="successor-version"/);
    expect(res.headers.link).toContain(successorPath);
  };

  it('legacy unversioned /health advertises successor /v1/health', async () => {
    const res = await request(app).get('/health');
    expectDeprecationHeaders(res, '/v1/health');
  });

  it('legacy unversioned /verify/:wallet advertises successor /v1/verify/:wallet', async () => {
    const res = await request(app).get('/verify/invalid-address');
    expectDeprecationHeaders(res, '/v1/verify/invalid-address');
  });

  it('legacy unversioned /auth/sep10 advertises successor /v1/auth/sep10', async () => {
    const res = await request(app).post('/auth/sep10').send({});
    expectDeprecationHeaders(res, '/v1/auth/sep10');
  });

  it('deprecated /v1 routes advertise successor /v2 routes', async () => {
    const res = await request(app).get('/v1/health');
    expectDeprecationHeaders(res, '/v2/health');
  });

  it('current /v1 routes do not emit deprecation headers', async () => {
    const res = await request(app).get('/v1/verify/invalid-address');
    expect(res.headers.deprecation).toBeUndefined();
    expect(res.headers.sunset).toBeUndefined();
    expect(res.headers.link).toBeUndefined();
  });
});