const { z } = require('zod');

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

  // Persistence strategy (see docs/persistence-strategy.md)
  // 'sqlite' = single-writer SQLite index; 'postgres' = multi-writer database
  DB_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  // Connection string for the multi-writer backend (required when DB_BACKEND=postgres)
  DATABASE_URL: z.string().optional(),
  // Milliseconds to wait for a write lock before failing the operation
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Interval between automatic index backups (0 disables scheduled backups)
  DB_BACKUP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3600000),
  // Directory where index backups are written
  DB_BACKUP_PATH: z.string().default('/data/backups'),
  // Number of most recent backups to retain
  DB_BACKUP_RETENTION: z.coerce.number().int().positive().default(7),
  // Run pending schema migrations on startup
  DB_MIGRATE_ON_START: z.coerce.boolean().default(true),
  // Fail startup instead of continuing when migrations cannot be applied
  DB_MIGRATE_STRICT: z.coerce.boolean().default(true),

  // Public verification response limits
  // Maximum number of history entries returned for a single record
  MAX_RECORD_HISTORY: z.coerce.number().int().positive().default(100),
  // Default page size for paginated record/history responses
  DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(20),
  // Maximum number of items accepted in a single batch verification request
  MAX_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  // Proxy / client IP derivation
  // Express trust-proxy setting: 'false', 'true', a hop count, or a subnet list
  TRUST_PROXY: z.string().default('false'),

  // Audit logging
  AUDIT_LOG_PATH: z.string().default('/data/audit/audit.log'),
  // Maximum size of a single audit log file before rotation, in bytes
  AUDIT_LOG_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
  // Number of rotated audit log files to retain
  AUDIT_LOG_RETENTION: z.coerce.number().int().positive().default(10),
  // Secret used to compute the tamper-evident hash chain over audit entries
  AUDIT_LOG_INTEGRITY_KEY: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.DB_BACKEND === 'postgres' && !val.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required when DB_BACKEND=postgres',
    });
  }
  if (val.DEFAULT_PAGE_SIZE > val.MAX_RECORD_HISTORY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEFAULT_PAGE_SIZE'],
      message: 'DEFAULT_PAGE_SIZE must not exceed MAX_RECORD_HISTORY',
    });
  }
});

function validateEnv(env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path[0]}: ${i.message}`).join('\n');
    throw new Error(`[config] Missing or invalid environment variables:\n${missing}`);
  }
  return result.data;
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
