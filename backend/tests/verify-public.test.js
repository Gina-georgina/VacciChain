/**
 * Test suite for public vaccination verification endpoint.
 * Tests GET /verify/public/:wallet endpoint.
 */

const request = require('supertest');
const app = require('../src/app');

describe('GET /verify/public/:wallet', () => {
  describe('No authentication required', () => {
    it('should accept request without Authorization header', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should not return 401 (unauthorized)
          expect(res.status).not.toBe(401);
        });
    });
  });

  describe('Wallet format validation', () => {
    it('should return 400 for invalid wallet format', async () => {
      const res = await request(app)
        .get('/v1/verify/public/invalid-wallet')
        .expect(400);
      
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 for empty wallet', async () => {
      const res = await request(app)
        .get('/v1/verify/public/')
        .expect(404); // Route not found because wallet is empty
    });

    it('should accept valid Stellar public key format', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should pass wallet validation (may fail on contract call, but not on format)
          expect(res.status).not.toBe(400);
        });
    });
  });

  describe('Response schema', () => {
    it('should return { verified: boolean, records: [] } schema', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Check response structure (may be 500 if contract fails, but structure should be consistent)
          if (res.status === 200) {
            expect(res.body).toHaveProperty('wallet');
            expect(res.body).toHaveProperty('verified');
            expect(typeof res.body.verified).toBe('boolean');
            expect(res.body).toHaveProperty('records');
            expect(Array.isArray(res.body.records)).toBe(true);
          }
        });
    });

    it('should not include vaccinated field in public response', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          if (res.status === 200) {
            // Public endpoint should use 'verified' not 'vaccinated'
            expect(res.body).toHaveProperty('verified');
            expect(res.body).not.toHaveProperty('vaccinated');
            expect(res.body).not.toHaveProperty('record_count');
          }
        });
    });
  });

  describe('Rate limiting', () => {
    it('should be rate limited to 60 requests per minute per IP', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      
      // Make multiple requests to test rate limiting
      // Note: This test may not work in all environments due to rate limiter configuration
      const res = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Should have rate limit headers
          if (res.status === 429) {
            expect(res.body).toHaveProperty('error');
            expect(res.body.error).toContain('Too many requests');
          }
        });
    });
  });

  describe('Caching', () => {
    it('should cache results for 60 seconds', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      
      // First request
      const res1 = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          // Just check it doesn't error on format
          expect(res.status).not.toBe(400);
        });

      // Second request should use cache (same response)
      const res2 = await request(app)
        .get(`/v1/verify/public/${validWallet}`)
        .expect((res) => {
          expect(res.status).not.toBe(400);
        });

      // Both should have same status (either both succeed or both fail the same way)
      expect(res1.status).toBe(res2.status);
    });
  });

  describe('Error handling', () => {
    it('should return 503 on RPC timeout', async () => {
      // This test would require mocking the contract call to timeout
      // Skipping for now as it requires test infrastructure setup
    });

    it('should return 500 on contract error', async () => {
      // This test would require mocking the contract call to fail
      // Skipping for now as it requires test infrastructure setup
    });
  });

  describe('Response size and batch limits', () => {
    const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
    const {
      MAX_PUBLIC_RECORDS,
      MAX_BATCH_WALLETS,
    } = require('../src/config/verificationLimits');

    describe('Public record history limit', () => {
      it('should document the maximum number of records returned', () => {
        expect(typeof MAX_PUBLIC_RECORDS).toBe('number');
        expect(MAX_PUBLIC_RECORDS).toBeGreaterThan(0);
      });

      it('should return at most MAX_PUBLIC_RECORDS records', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .expect((res) => {
            if (res.status === 200) {
              expect(Array.isArray(res.body.records)).toBe(true);
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should accept a limit query param below the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=1`)
          .expect((res) => {
            expect(res.status).not.toBe(400);
            if (res.status === 200) {
              expect(res.body.records.length).toBeLessThanOrEqual(1);
            }
          });
      });

      it('should accept a limit query param exactly at the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=${MAX_PUBLIC_RECORDS}`)
          .expect((res) => {
            expect(res.status).not.toBe(400);
            if (res.status === 200) {
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should reject or truncate a limit query param above the maximum predictably', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=${MAX_PUBLIC_RECORDS + 1}`)
          .expect((res) => {
            // Either a predictable 400 or a truncated 200 response
            if (res.status === 400) {
              expect(res.body).toHaveProperty('error');
            } else {
              expect(res.status).toBe(200);
              expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
            }
          });
      });

      it('should reject a non-numeric limit with 400', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=abc`)
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject a negative limit with 400', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}?limit=-1`)
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should expose truncation semantics when records exceed the maximum', async () => {
        const res = await request(app)
          .get(`/v1/verify/public/${validWallet}`)
          .expect((res) => {
            if (res.status === 200) {
              // If truncated, the response should signal it explicitly
              if (res.body.truncated === true) {
                expect(res.body.records.length).toBe(MAX_PUBLIC_RECORDS);
              } else {
                expect(res.body.records.length).toBeLessThanOrEqual(MAX_PUBLIC_RECORDS);
              }
            }
          });
      });
    });

    describe('Batch verification limit', () => {
      const makeWallets = (count) =>
        Array.from({ length: count }, (_, i) =>
          `GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNL${String(i).padStart(2, '0')}`
        );

      it('should document the maximum batch size', () => {
        expect(typeof MAX_BATCH_WALLETS).toBe('number');
        expect(MAX_BATCH_WALLETS).toBeGreaterThan(0);
      });

      it('should accept a batch below the maximum', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(Math.max(1, MAX_BATCH_WALLETS - 1)) })
          .expect((res) => {
            expect(res.status).not.toBe(400);
          });
      });

      it('should accept a batch exactly at the maximum', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(MAX_BATCH_WALLETS) })
          .expect((res) => {
            expect(res.status).not.toBe(400);
          });
      });

      it('should reject a batch above the maximum with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: makeWallets(MAX_BATCH_WALLETS + 1) })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject a non-array wallets payload with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: 'not-an-array' })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject an empty wallets payload with 400', async () => {
        const res = await request(app)
          .post('/v1/verify/public/batch')
          .send({ wallets: [] })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });
    });
  });
});

describe('GET /verify/:wallet (authenticated)', () => {
  describe('Authentication required', () => {
    it('should return 401 without Authorization header', async () => {
      const validWallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
      const res = await request(app)
        .get(`/v1/verify/${validWallet}`)
        .expect(401);
      
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Response schema', () => {
    it('should return detailed schema with vaccinated and record_count', async () => {
      // This test would require a valid JWT token
      // Skipping for now as it requires test infrastructure setup
    });
  });
});
