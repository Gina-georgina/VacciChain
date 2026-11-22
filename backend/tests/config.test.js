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
});

describe('validateConfig', () => {
  const baseConfig = {
    ...valid,
    PORT: 3000,
    STELLAR_NETWORK: 'testnet',
    MAX_BATCH_SIZE: 100,
    MIN_BATCH_SIZE: 1,
    REQUEST_TIMEOUT_MS: 30000,
  };

  it('passes with a fully valid configuration', () => {
    expect(() => validateConfig(baseConfig)).not.toThrow();
  });

  it('throws naming each missing required variable', () => {
    for (const key of [
      'HORIZON_URL',
      'SOROBAN_RPC_URL',
      'STELLAR_NETWORK_PASSPHRASE',
      'VACCINATIONS_CONTRACT_ID',
      'ADMIN_SECRET_KEY',
      'SEP10_SERVER_KEY',
      'JWT_SECRET',
    ]) {
      const env = { ...baseConfig };
      delete env[key];
      expect(() => validateConfig(env)).toThrow(key);
    }
  });

  it('throws on malformed URLs', () => {
    expect(() => validateConfig({ ...baseConfig, HORIZON_URL: 'not-a-url' })).toThrow(
      'HORIZON_URL'
    );
    expect(() => validateConfig({ ...baseConfig, SOROBAN_RPC_URL: 'ftp://bad' })).toThrow(
      'SOROBAN_RPC_URL'
    );
  });

  it('throws on an invalid network name', () => {
    expect(() => validateConfig({ ...baseConfig, STELLAR_NETWORK: 'devnet' })).toThrow(
      'STELLAR_NETWORK'
    );
  });

  it('throws when the network and passphrase contradict each other', () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        STELLAR_NETWORK: 'mainnet',
        STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      })
    ).toThrow(/STELLAR_NETWORK/);
  });

  it('throws on out-of-range limits', () => {
    expect(() => validateConfig({ ...baseConfig, PORT: 0 })).toThrow('PORT');
    expect(() => validateConfig({ ...baseConfig, PORT: 70000 })).toThrow('PORT');
    expect(() => validateConfig({ ...baseConfig, MAX_BATCH_SIZE: -1 })).toThrow(
      'MAX_BATCH_SIZE'
    );
    expect(() =>
      validateConfig({ ...baseConfig, MIN_BATCH_SIZE: 10, MAX_BATCH_SIZE: 5 })
    ).toThrow(/BATCH_SIZE/);
    expect(() => validateConfig({ ...baseConfig, REQUEST_TIMEOUT_MS: 0 })).toThrow(
      'REQUEST_TIMEOUT_MS'
    );
  });

  it('throws when ADMIN_SECRET_KEY equals SEP10_SERVER_KEY', () => {
    expect(() =>
      validateConfig({ ...baseConfig, SEP10_SERVER_KEY: baseConfig.ADMIN_SECRET_KEY })
    ).toThrow(/ADMIN_SECRET_KEY|SEP10_SERVER_KEY/);
  });

  it('throws when JWT_SECRET is too short', () => {
    expect(() => validateConfig({ ...baseConfig, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });

  it('does not call process.exit on invalid configuration', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    expect(() => validateConfig({ ...baseConfig, PORT: -1 })).toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
