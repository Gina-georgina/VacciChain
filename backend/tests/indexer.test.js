const os = require('os');
const path = require('path');
const fs = require('fs');
const { initDb, upsertEvents, queryEvents, getLatestLedger } = require('../src/indexer/db');
const { parseEvent, stopPoller } = require('../src/indexer/poller');
const { vaccinationRecordFactory } = require('./factories');


const tmpDb = path.join(os.tmpdir(), `vaccichain-test-${Date.now()}.db`);

beforeAll(async () => {
  await initDb(tmpDb);
});

afterAll(() => {
  stopPoller();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

describe('db — upsertEvents / queryEvents', () => {
  const record = vaccinationRecordFactory({ vaccine_name: 'COVID-19', issuer_address: 'GISSUER1' });
  const sample = [
    {
      id: 'evt-001',
      event_type: 'VaccinationMinted',
      ledger: 100,
      timestamp: 1700000000,
      contract_id: 'CABC',
      payload: { vaccine_name: record.vaccine_name, issuer: record.issuer_address },
    },
    {
      id: 'evt-002',
      event_type: 'IssuerAdded',
      ledger: 101,
      timestamp: 1700000060,
      contract_id: 'CABC',
      payload: { issuer: 'GISSUER2' },
    },
  ];


  it('stores events and returns them', () => {
    upsertEvents(sample);
    const results = queryEvents();
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates on re-insert', () => {
    upsertEvents(sample); // insert same events again
    const results = queryEvents({ event_type: 'VaccinationMinted' });
    const ids = results.map((e) => e.id);
    expect(ids.filter((id) => id === 'evt-001').length).toBe(1);
  });

  it('filters by event_type', () => {
    const minted = queryEvents({ event_type: 'VaccinationMinted' });
    expect(minted.every((e) => e.event_type === 'VaccinationMinted')).toBe(true);

    const added = queryEvents({ event_type: 'IssuerAdded' });
    expect(added.every((e) => e.event_type === 'IssuerAdded')).toBe(true);
  });

  it('deserialises payload back to object', () => {
    const [evt] = queryEvents({ event_type: 'VaccinationMinted' });
    expect(typeof evt.payload).toBe('object');
    expect(evt.payload.vaccine_name).toBe(record.vaccine_name);

  });

  it('getLatestLedger returns highest ledger', () => {
    expect(getLatestLedger()).toBeGreaterThanOrEqual(101);
  });

  it('respects limit and offset', () => {
    const first = queryEvents({ limit: 1, offset: 0 });
    const second = queryEvents({ limit: 1, offset: 1 });
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0].id).not.toBe(second[0].id);
  });
});

describe('poller — parseEvent', () => {
  it('maps minted topic to VaccinationMinted', () => {
    const raw = {
      id: 'raw-001',
      topic: [{ value: { toString: () => 'minted' } }],
      ledger: 200,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: 'CABC',
      value: { vaccine_name: 'Flu' },
    };
    const parsed = parseEvent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed.event_type).toBe('VaccinationMinted');
    expect(parsed.ledger).toBe(200);
  });

  it('maps iss_add topic to IssuerAdded', () => {
    const raw = {
      id: 'raw-002',
      topic: [{ value: { toString: () => 'iss_add' } }],
      ledger: 201,
      ledgerClosedAt: '2024-01-01T00:01:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw).event_type).toBe('IssuerAdded');
  });

  it('maps iss_rev topic to IssuerRevoked', () => {
    const raw = {
      id: 'raw-003',
      topic: [{ value: { toString: () => 'iss_rev' } }],
      ledger: 202,
      ledgerClosedAt: '2024-01-01T00:02:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw).event_type).toBe('IssuerRevoked');
  });

  it('returns null for unknown topic', () => {
    const raw = {
      id: 'raw-004',
      topic: [{ value: { toString: () => 'unknown_event' } }],
      ledger: 203,
      ledgerClosedAt: '2024-01-01T00:03:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw)).toBeNull();
  });

  it('returns null when topic is missing', () => {
    expect(parseEvent({ id: 'raw-005', ledger: 204 })).toBeNull();
  });
});

describe('persistence strategy — locking, backup, failover, migration', () => {
  const { backupDb, restoreDb, migrateDb, withWriteLock } = require('../src/indexer/db');
  const strategy = require('../src/indexer/persistenceStrategy');

  it('documents a load and failure analysis comparing SQLite with a multi-writer database', () => {
    const analysis = strategy.loadAndFailureAnalysis();
    expect(analysis).toBeDefined();
    expect(analysis.currentStorage).toMatch(/sqlite/i);
    expect(analysis.multiWriterOption).toBeDefined();
    expect(typeof analysis.multiWriterOption.name).toBe('string');
    expect(analysis.multiWriterOption.name.length).toBeGreaterThan(0);
    expect(Array.isArray(analysis.comparison)).toBe(true);
    expect(analysis.comparison.length).toBeGreaterThan(0);
    expect(analysis.selectedArchitecture).toBeDefined();
  });

  it('serialises concurrent writes through the write lock without losing events', async () => {
    const writes = [];
    for (let i = 0; i < 20; i += 1) {
      writes.push(
        withWriteLock(() =>
          upsertEvents([
            {
              id: `lock-${i}`,
              event_type: 'VaccinationMinted',
              ledger: 500 + i,
              timestamp: 1700000000 + i,
              contract_id: 'CABC',
              payload: { seq: i },
            },
          ])
        )
      );
    }
    await Promise.all(writes);
    const stored = queryEvents({ event_type: 'VaccinationMinted' }).filter((e) =>
      e.id.startsWith('lock-')
    );
    expect(stored.length).toBe(20);
  });

  it('backs up and restores the index without data loss', async () => {
    const backupPath = path.join(os.tmpdir(), `vaccichain-backup-${Date.now()}.db`);
    try {
      await backupDb(backupPath);
      expect(fs.existsSync(backupPath)).toBe(true);

      const before = queryEvents().length;
      await restoreDb(backupPath);
      const after = queryEvents().length;
      expect(after).toBe(before);
    } finally {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    }
  });

  it('recovers from a simulated failover by reopening the database', async () => {
    const failoverPath = path.join(os.tmpdir(), `vaccichain-failover-${Date.now()}.db`);
    try {
      await initDb(failoverPath);
      upsertEvents([
        {
          id: 'failover-001',
          event_type: 'IssuerAdded',
          ledger: 900,
          timestamp: 1700000000,
          contract_id: 'CABC',
          payload: { issuer: 'GISSUER9' },
        },
      ]);
      // Simulate failover: re-initialise against the same file.
      await initDb(failoverPath);
      const recovered = queryEvents({ event_type: 'IssuerAdded' }).filter(
        (e) => e.id === 'failover-001'
      );
      expect(recovered.length).toBe(1);
    } finally {
      await initDb(tmpDb);
      if (fs.existsSync(failoverPath)) fs.unlinkSync(failoverPath);
    }
  });

  it('runs migrations idempotently and reports the schema version', async () => {
    const first = await migrateDb();
    const second = await migrateDb();
    expect(typeof first.version).toBe('number');
    expect(second.version).toBe(first.version);
    expect(second.applied).toBe(0);
  });
});

describe('GET /events route', () => {
  const request = require('supertest');
  const app = require('../src/app');

  it('returns events array', async () => {
    const res = await request(app).get('/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  it('filters by event_type', async () => {
    const res = await request(app).get('/events?event_type=VaccinationMinted');
    expect(res.status).toBe(200);
    res.body.events.forEach((e) => expect(e.event_type).toBe('VaccinationMinted'));
  });

  it('respects limit param', async () => {
    const res = await request(app).get('/events?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(1);
  });
});
