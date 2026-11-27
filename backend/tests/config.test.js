const { validateEnv } = require('../src/config');

const valid = {
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  VACCINATIONS_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  ADMIN_SECRET_KEY: 'STEST000000000000000000000000000000000000000000000000000',
  SEP10_SERVER_KEY: 'STEST000000000000000000000000000000000000000000000000001',
  JWT_SECRET: 'test-jwt-secret',
};

describe('validateEnv', () => {
  it('passes with all required variables present', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('throws with the variable name when a required variable is missing', () => {
    const { HORIZON_URL: _, ...env } = valid;
    expect(() => validateEnv(env)).toThrow('HORIZON_URL');
  });

  it('throws a format error when ADMIN_SECRET_KEY does not start with S', () => {
    expect(() => validateEnv({ ...valid, ADMIN_SECRET_KEY: 'XBADKEY' })).toThrow(
      'ADMIN_SECRET_KEY'
    );
  });

  it('throws when STELLAR_NETWORK is set to an invalid value', () => {
    expect(() => validateEnv({ ...valid, STELLAR_NETWORK: 'devnet' })).toThrow('STELLAR_NETWORK');
  });

  it('is callable without side effects (no process.exit)', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    expect(() => validateEnv({ ...valid, HORIZON_URL: 'not-a-url' })).toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  describe('trusted proxy configuration', () => {
    it('accepts a boolean TRUST_PROXY value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'true' })).not.toThrow();
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'false' })).not.toThrow();
    });

    it('accepts a hop count TRUST_PROXY value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: '1' })).not.toThrow();
    });

    it('accepts a comma-separated list of trusted proxy addresses', () => {
      expect(() =>
        validateEnv({ ...valid, TRUST_PROXY: '10.0.0.1, 192.168.1.0/24' })
      ).not.toThrow();
    });

    it('throws when TRUST_PROXY is set to an invalid value', () => {
      expect(() => validateEnv({ ...valid, TRUST_PROXY: 'yes-please' })).toThrow('TRUST_PROXY');
    });
  });

  describe('rate limit configuration', () => {
    it('accepts positive integer limits for onboarding and batch verification', () => {
      expect(() =>
        validateEnv({
          ...valid,
          RATE_LIMIT_ONBOARDING: '10',
          RATE_LIMIT_BATCH_VERIFY: '5',
        })
      ).not.toThrow();
    });

    it('throws when RATE_LIMIT_ONBOARDING is not a positive integer', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_ONBOARDING: '0' })).toThrow(
        'RATE_LIMIT_ONBOARDING'
      );
      expect(() => validateEnv({ ...valid, RATE_LIMIT_ONBOARDING: 'abc' })).toThrow(
        'RATE_LIMIT_ONBOARDING'
      );
    });

    it('throws when RATE_LIMIT_BATCH_VERIFY is not a positive integer', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_BATCH_VERIFY: '-1' })).toThrow(
        'RATE_LIMIT_BATCH_VERIFY'
      );
    });

    it('accepts supported RATE_LIMIT_STORE values', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'memory' })).not.toThrow();
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'redis' })).not.toThrow();
    });

    it('throws when RATE_LIMIT_STORE is set to an unsupported value', () => {
      expect(() => validateEnv({ ...valid, RATE_LIMIT_STORE: 'sqlite' })).toThrow(
        'RATE_LIMIT_STORE'
      );
    });
  });
});
