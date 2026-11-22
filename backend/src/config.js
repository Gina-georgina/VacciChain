const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const schema = z.object({
  // Stellar / Soroban
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  HORIZON_URL: z.string().url(),
  SOROBAN_RPC_URL: z.string().url(),
  SOROBAN_RPC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),

  // Contract
  VACCINATIONS_CONTRACT_ID: z.string().min(1),

  // Backend
  ADMIN_SECRET_KEY: z.string().min(1).refine(v => v.startsWith('S'), {
    message: 'ADMIN_SECRET_KEY must start with S',
  }),
  SEP10_SERVER_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  // Comma-separated list of allowed origins, e.g. https://app.example.com,https://admin.example.com
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // SEP-10: home domain used as the manage_data key prefix ('<HOME_DOMAIN> auth')
  HOME_DOMAIN: z.string().min(1).default('localhost'),
  // SEP-10: domain of this auth server, included in the web_auth_domain manage_data op
  WEB_AUTH_DOMAIN: z.string().min(1).default('localhost'),

  // Transaction fees (stroops; 1 XLM = 10_000_000 stroops)
  SOROBAN_FEE: z.coerce.number().int().positive().default(100),
  SOROBAN_TIP: z.coerce.number().int().min(0).default(0),

  // Health probe interval for cached dependency status
  HEALTH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),

  // Request limits
  BODY_LIMIT: z.string().default('10kb'),

  // Indexer
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DATABASE_PATH: z.string().default('/data/vaccichain.db'),
});

// Expected network passphrases for each Stellar network.
const NETWORK_PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

// Hostname fragments that identify a network's Horizon / Soroban RPC endpoints.
const NETWORK_HOST_HINTS = {
  testnet: ['testnet', 'horizon-testnet', 'soroban-testnet', 'futurenet'],
  mainnet: ['horizon.stellar.org', 'soroban.stellar.org', 'mainnet'],
};

// Sane ranges for numeric limits.
const NUMERIC_RANGES = {
  PORT: [1, 65535],
  SOROBAN_RPC_MAX_RETRIES: [0, 20],
  SOROBAN_RPC_TIMEOUT_MS: [100, 300000],
  SOROBAN_FEE: [1, 10000000],
  SOROBAN_TIP: [0, 10000000],
  HEALTH_POLL_INTERVAL_MS: [1000, 3600000],
  EVENT_POLL_INTERVAL_MS: [1000, 3600000],
};

function hostMatchesNetwork(url, network) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hints = NETWORK_HOST_HINTS[network] || [];
  return hints.some(hint => hostname.includes(hint));
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce cross-field constraints on an already Zod-parsed config object.
 * Throws a single aggregated, actionable error if any constraint fails.
 */
function validateConfig(cfg) {
  const errors = [];

  // --- Network / contract consistency ---
  const network = cfg.STELLAR_NETWORK;
  const expectedPassphrase = NETWORK_PASSPHRASES[network];
  if (expectedPassphrase && cfg.STELLAR_NETWORK_PASSPHRASE !== expectedPassphrase) {
    errors.push(
      `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="${network}". ` +
        `Expected "${expectedPassphrase}".`
    );
  }

  for (const key of ['HORIZON_URL', 'SOROBAN_RPC_URL']) {
    if (!hostMatchesNetwork(cfg[key], network)) {
      errors.push(
        `${key}="${cfg[key]}" does not look like a ${network} endpoint. ` +
          `Expected host to contain one of: ${(NETWORK_HOST_HINTS[network] || []).join(', ')}.`
      );
    }
  }

  if (cfg.VACCINATIONS_CONTRACT_ID && !/^C[A-Z0-9]{55}$/.test(cfg.VACCINATIONS_CONTRACT_ID)) {
    errors.push(
      `VACCINATIONS_CONTRACT_ID="${cfg.VACCINATIONS_CONTRACT_ID}" is not a valid Soroban contract ID ` +
        `(expected "C" followed by 55 uppercase alphanumeric characters).`
    );
  }

  // --- Secret combination checks ---
  if (cfg.ADMIN_SECRET_KEY === cfg.SEP10_SERVER_KEY) {
    errors.push('ADMIN_SECRET_KEY and SEP10_SERVER_KEY must be distinct keys.');
  }
  if (cfg.JWT_SECRET === cfg.ADMIN_SECRET_KEY || cfg.JWT_SECRET === cfg.SEP10_SERVER_KEY) {
    errors.push('JWT_SECRET must not reuse ADMIN_SECRET_KEY or SEP10_SERVER_KEY.');
  }

  // --- Numeric limit ranges ---
  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const value = cfg[key];
    if (typeof value === 'number' && (value < min || value > max)) {
      errors.push(`${key}=${value} is out of range (expected ${min}..${max}).`);
    }
  }

  // --- ALLOWED_ORIGINS entries must be valid URLs ---
  const origins = String(cfg.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    errors.push('ALLOWED_ORIGINS must contain at least one origin.');
  }
  for (const origin of origins) {
    try {
      // eslint-disable-next-line no-new
      new URL(origin);
    } catch {
      errors.push(`ALLOWED_ORIGINS entry "${origin}" is not a valid URL.`);
    }
  }

  // --- DATABASE_PATH parent directory must be writable ---
  const dbPath = cfg.DATABASE_PATH;
  if (dbPath) {
    const parent = path.dirname(dbPath);
    if (!fs.existsSync(parent)) {
      errors.push(`DATABASE_PATH parent directory "${parent}" does not exist.`);
    } else if (!isWritableDir(parent)) {
      errors.push(`DATABASE_PATH parent directory "${parent}" is not writable.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[config] Invalid configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`
    );
  }

  return cfg;
}

function validateEnv(env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path[0]}: ${i.message}`).join('\n');
    throw new Error(`[config] Missing or invalid environment variables:\n${missing}`);
  }
  return validateConfig(result.data);
}

const config = (() => {
  try {
    return validateEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();

module.exports = config;
module.exports.validateEnv = validateEnv;
module.exports.validateConfig = validateConfig;
