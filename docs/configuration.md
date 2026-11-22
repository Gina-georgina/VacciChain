# Configuration Reference

All environment variables consumed by the VacciChain stack. Copy `.env.example` to `.env` and fill in the required values before starting any service.

```bash
cp .env.example .env
```

The backend validates its variables at startup via [Zod](https://zod.dev/). A missing or malformed required variable will print a clear error and exit with code 1 — no cryptic runtime failures.

---

## Stellar / Soroban

### `STELLAR_NETWORK`
- Required: no
- Default: `testnet`
- Allowed values: `testnet` | `mainnet`
- Description: Selects the Stellar network. Controls which network passphrase is used when signing transactions. Must match `HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE`.
- Example: `STELLAR_NETWORK=testnet`

### `HORIZON_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Horizon REST API endpoint for the chosen network.
- Example (testnet): `HORIZON_URL=https://horizon-testnet.stellar.org`
- Example (mainnet): `HORIZON_URL=https://horizon.stellar.org`

### `SOROBAN_RPC_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Soroban RPC endpoint used to simulate and submit contract transactions.
- Example (testnet): `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`
- Example (mainnet): `SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com`

### `STELLAR_NETWORK_PASSPHRASE`
- Required: yes
- Format: non-empty string
- Description: Network passphrase included in every transaction envelope. Must exactly match the target network.
- Example (testnet): `STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015`
- Example (mainnet): `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`

---

## Contract

### `VACCINATIONS_CONTRACT_ID`
- Required: yes
- Format: 56-character Stellar contract address (starts with `C`)
- Description: Deployed address of the VacciChain Soroban contract. Obtained from `make deploy` in the `contracts/` directory.
- Example: `VACCINATIONS_CONTRACT_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

---

## Backend auth

### `ADMIN_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key of the account used to sign admin-level contract invocations (e.g. `add_issuer`, `revoke_issuer`). Keep this secret — never commit it.
- Example: `ADMIN_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `ADMIN_PUBLIC_KEY`
- Required: yes
- Format: 56-character Stellar public key (starts with `G`)
- Description: Public key corresponding to `ADMIN_SECRET_KEY`. Used by the auth route to assign the `issuer` role when the admin wallet authenticates via SEP-10.
- Example: `ADMIN_PUBLIC_KEY=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZSR`

### `SEP10_SERVER_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign SEP-10 challenge transactions. Should be a dedicated key, separate from `ADMIN_SECRET_KEY`.
- Example: `SEP10_SERVER_KEY=SBPOVRCGGG65T7FQBV5KCBZ7HNZSZQZQZQZQZQZQZQZQZQZQZQZQZQZ`

### `ISSUER_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign vaccination minting and revocation transactions submitted to the contract. Must correspond to an address authorized as an issuer on-chain.
- Example: `ISSUER_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `JWT_SECRET`
- Required: yes
- Format: non-empty string; minimum 32 characters recommended
- Description: Secret used to sign and verify JWTs issued after SEP-10 authentication. Rotate this to invalidate all active sessions.
- Example: `JWT_SECRET=change-me-to-a-long-random-string-in-production`

---

## Backend server

### `PORT`
- Required: no
- Default: `4000`
- Format: positive integer
- Description: TCP port the Express backend listens on.
- Example: `PORT=4000`

### `TRUST_PROXY`
- Required: no
- Default: `false`
- Allowed values: `false` | `true` | `loopback` | `linklocal` | `uniquelocal` | a comma-separated list of IP addresses/CIDR ranges | a non-negative integer (number of trusted hops)
- Description: Value passed to Express `app.set('trust proxy', ...)`. Controls how the client IP is derived from `X-Forwarded-For` / `X-Real-IP`. Must match the deployed load-balancer topology: set `false` when the backend is directly exposed, `1` (or the LB's CIDR) when exactly one trusted proxy sits in front, and so on. When unset or `false`, forwarded headers are ignored and the socket address is used, preventing spoofed headers from bypassing rate limits or corrupting audit attribution.
- Example (single load balancer): `TRUST_PROXY=1`
- Example (known proxy range): `TRUST_PROXY=10.0.0.0/8,192.168.1.10`

---

## Event index persistence

The backend maintains a local event index (SQLite by default) of on-chain vaccination events. The persistence strategy is documented in `docs/persistence-strategy.md`; the variables below select and tune it.

### `DATABASE_PATH`
- Required: no
- Default: `/data/vaccichain.db`
- Format: file path; the parent directory must be writable
- Description: Path to the SQLite database file used for the event index. Ignored when `DATABASE_URL` is set.
- Example: `DATABASE_PATH=/data/vaccichain.db`

### `DATABASE_URL`
- Required: no
- Default: unset (SQLite via `DATABASE_PATH`)
- Format: PostgreSQL connection URL (`postgres://user:pass@host:5432/db`)
- Description: When set, the event index uses the multi-writer PostgreSQL backend instead of SQLite. Required when running more than one backend task against a shared index. See `docs/persistence-strategy.md` for the load and failure analysis and the migration procedure.
- Example: `DATABASE_URL=postgres://vaccichain:secret@db:5432/vaccichain`

### `DATABASE_POOL_SIZE`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum number of pooled connections per backend task when `DATABASE_URL` is set. Size so that `DATABASE_POOL_SIZE × backend task count` stays below the database's `max_connections`.
- Example: `DATABASE_POOL_SIZE=10`

### `DATABASE_BUSY_TIMEOUT_MS`
- Required: no
- Default: `5000`
- Format: positive integer (milliseconds)
- Description: SQLite busy timeout applied to the event index connection. Longer values reduce `SQLITE_BUSY` errors under write contention at the cost of latency.
- Example: `DATABASE_BUSY_TIMEOUT_MS=5000`

### `DATABASE_BACKUP_PATH`
- Required: no
- Default: unset (scheduled backups disabled)
- Format: directory path; must be writable
- Description: Directory where periodic event index backups are written. Backups use SQLite's online backup API (or `pg_dump` for PostgreSQL) and are safe to take while the service is running.
- Example: `DATABASE_BACKUP_PATH=/var/backups/vaccichain`

### `DATABASE_BACKUP_INTERVAL_MINUTES`
- Required: no
- Default: `60`
- Format: positive integer
- Description: How often the event index backup job runs. Only used when `DATABASE_BACKUP_PATH` is set.
- Example: `DATABASE_BACKUP_INTERVAL_MINUTES=60`

---

## Public verification limits

Public verification endpoints (`GET /verify/:wallet`, batch verification) are bounded to protect memory, CPU, and response bandwidth.

### `VERIFY_MAX_RECORDS`
- Required: no
- Default: `100`
- Format: positive integer
- Description: Maximum number of vaccination records returned in a single public record response. When a wallet has more records, the response is truncated and includes pagination metadata (`total`, `returned`, `truncated`, `nextCursor`). Clients page through the remainder with the `cursor` query parameter.
- Example: `VERIFY_MAX_RECORDS=100`

### `VERIFY_MAX_BATCH_SIZE`
- Required: no
- Default: `50`
- Format: positive integer
- Description: Maximum number of wallets accepted in a single batch verification request. Requests above this limit are rejected with HTTP 413 before any lookup work is performed.
- Example: `VERIFY_MAX_BATCH_SIZE=50`

### `VERIFY_MAX_PAGE_SIZE`
- Required: no
- Default: `100`
- Format: positive integer
- Description: Upper bound for the `limit` query parameter on paginated public verification responses. Values above this are clamped to the maximum.
- Example: `VERIFY_MAX_PAGE_SIZE=100`

---

## Rate limiting

### `RATE_LIMIT_SEP10`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum SEP-10 challenge requests per IP per minute. Protects the challenge endpoint from enumeration and DoS.
- Example: `RATE_LIMIT_SEP10=10`

### `RATE_LIMIT_VERIFY`
- Required: no
- Default: `60`
- Format: positive integer
- Description: Maximum public verification requests (`GET /verify/:wallet`) per IP per minute.
- Example: `RATE_LIMIT_VERIFY=60`

---

## Audit log

### `AUDIT_LOG_PATH`
- Required: no
- Default: `./audit.log` (relative to the backend working directory)
- Format: valid file path; the parent directory must be writable
- Description: Path to the append-only NDJSON audit log file. Each line is a JSON object with `timestamp`, `requestId`, `actor`, `action`, `target`, `result`, and `meta`. Mint, revoke, consent, and administrative changes are always recorded. Never deleted or updated — only appended.
- Example: `AUDIT_LOG_PATH=/var/log/vaccichain/audit.log`

### `AUDIT_LOG_MAX_BYTES`
- Required: no
- Default: `10485760` (10 MiB)
- Format: positive integer (bytes)
- Description: Size at which the current audit log file is rotated. On rotation the active file is renamed with a timestamp suffix and a new file is opened; rotation is atomic with respect to appends.
- Example: `AUDIT_LOG_MAX_BYTES=10485760`

### `AUDIT_LOG_MAX_FILES`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Number of rotated audit log files retained. Older files are deleted once this count is exceeded. Set `0` to retain rotated files indefinitely (not recommended in production).
- Example: `AUDIT_LOG_MAX_FILES=10`

### `AUDIT_LOG_RETENTION_DAYS`
- Required: no
- Default: `90`
- Format: positive integer
- Description: Maximum age (in days) of rotated audit log files. Files older than this are removed by the retention job regardless of `AUDIT_LOG_MAX_FILES`. Set `0` to disable age-based retention.
- Example: `AUDIT_LOG_RETENTION_DAYS=90`

### `AUDIT_LOG_INTEGRITY_KEY`
- Required: no
- Default: unset (hash chaining only)
- Format: non-empty string; minimum 32 characters recommended
- Description: Secret used to compute the HMAC that chains each audit entry to its predecessor, making the log tamper-evident. When unset, entries are still hash-chained but the chain cannot be authenticated. Rotate only together with a documented re-seal procedure (see `docs/audit-log.md`).
- Example: `AUDIT_LOG_INTEGRITY_KEY=change-me-to-a-long-random-string`

### `AUDIT_LOG_VERIFY_ON_START`
- Required: no
- Default: `true`
- Format: boolean (`true` | `false`)
- Description: When enabled, the backend verifies the integrity chain of the active and rotated audit logs at startup and logs a warning (or fails fast, per `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR`) if a break is detected.
- Example: `AUDIT_LOG_VERIFY_ON_START=true`

### `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR`
- Required: no
- Default: `false`
- Format: boolean (`true` | `false`)
- Description: When `true`, an integrity verification failure at startup aborts the boot instead of logging a warning. Recommended for production deployments with strict audit requirements.
- Example: `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR=true`

### `AUDIT_LOG_FAILURE_MODE`
- Required: no
- Default: `fail-closed`
- Allowed values: `fail-closed` | `fail-open`
- Description: Behaviour when an audit entry cannot be written (e.g. disk full, permission error). `fail-closed` rejects the originating mint/revoke/consent/admin request so no action goes unrecorded; `fail-open` allows the action and emits a high-severity alert. `fail-closed` is required for production.
- Example: `AUDIT_LOG_FAILURE_MODE=fail-closed`

---

## Python analytics service

### `ANALYTICS_PORT`
- Required: no
- Default: `8001`
- Format: positive integer
- Description: TCP port the FastAPI analytics service listens on.
- Example: `ANALYTICS_PORT=8001`

### `BACKEND_URL`
- Required: no (set automatically by Docker Compose)
- Default: `http://backend:4000`
- Format: valid HTTP/HTTPS URL, no trailing slash
- Description: Base URL the analytics service uses to call the backend API. When running outside Docker, point this at the backend host.
- Example: `BACKEND_URL=http://localhost:4000`

---

## Anomaly detection

The Python analytics service runs a periodic job that flags issuers whose mint volume exceeds a configurable threshold and dispatches alerts via webhook.

### `ANOMALY_THRESHOLD`
- Required: no
- Default: `50`
- Format: positive integer
- Description: Number of mints above which an issuer is considered anomalous. The check compares each issuer's total lifetime mint count against this value. Lower values increase sensitivity (more alerts); higher values reduce noise. Start with the default and adjust based on your expected issuer volume.
- Tuning guidance:
  - Testnet / development: set low (e.g. `5`) to exercise the alert path without real data.
  - Production: baseline from 2–4 weeks of normal issuer activity, then set to ~2× the 99th-percentile daily volume per issuer.
- Example: `ANOMALY_THRESHOLD=50`

### `ANOMALY_SCHEDULE_MINUTES`
- Required: no
- Default: `15`
- Format: positive integer
- Description: How often (in minutes) the anomaly detection job runs. The scheduler uses APScheduler with an interval trigger. Shorter intervals catch anomalies faster but increase backend load; longer intervals reduce load but delay detection.
- Tuning guidance:
  - For near-real-time alerting use `5`.
  - For low-traffic deployments `30` or `60` is sufficient.
  - Do not set below `1` — the job itself takes a few seconds.
- Example: `ANOMALY_SCHEDULE_MINUTES=15`

---

## Webhook alerts

When an anomaly is detected the service POSTs a JSON payload to `ALERT_WEBHOOK_URL`. Three payload formats are supported, selected by `ALERT_WEBHOOK_TYPE`.

### `ALERT_WEBHOOK_URL`
- Required: no (alerts are silently skipped when unset)
- Format: valid HTTPS URL
- Description: Endpoint that receives alert POSTs. Must accept `application/json`. Leave empty to disable alerting.
- Slack example URL format: `https://hooks.slack.com/services/<TEAM_ID>/<CHANNEL_ID>/<TOKEN>` (obtain from your Slack app's Incoming Webhooks page)
- Example: `ALERT_WEBHOOK_URL=https://your-webhook-endpoint.example.com/alert`

### `ALERT_WEBHOOK_TYPE`
- Required: no
- Default: `slack`
- Allowed values: `slack` | `pagerduty` | `email`
- Description: Controls the JSON payload shape sent to `ALERT_WEBHOOK_URL`.
- Example: `ALERT_WEBHOOK_TYPE=slack`

### `PAGERDUTY_ROUTING_KEY`
- Required: when `ALERT_WEBHOOK_TYPE=pagerduty`
- Format: 32-character hex string
- Description: PagerDuty Events API v2 integration key. Obtain from your PagerDuty service's "Integrations" tab. Set `ALERT_WEBHOOK_URL` to `https://events.pagerduty.com/v2/enqueue`.
- Example: `PAGERDUTY_ROUTING_KEY=abc123def456abc123def456abc123de`

### `ALERT_EMAIL_TO`
- Required: when `ALERT_WEBHOOK_TYPE=email`
- Format: valid email address
- Description: Recipient address for email alerts. Your `ALERT_WEBHOOK_URL` must point to an HTTP-to-email relay (e.g. a custom endpoint or a service like Mailgun/SendGrid webhooks).
- Example: `ALERT_EMAIL_TO=ops@example.com`

---

### Alert payload formats

**Slack** (`ALERT_WEBHOOK_TYPE=slack`)

```json
{
  "text": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

**PagerDuty** (`ALERT_WEBHOOK_TYPE=pagerduty`)

```json
{
  "routing_key": "<PAGERDUTY_ROUTING_KEY>",
  "event_action": "trigger",
  "payload": {
    "summary": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00",
    "severity": "warning",
    "source": "vaccichain-analytics",
    "custom_details": {
      "issuer": "GABC...",
      "record_count": 73,
      "timestamp": "2025-01-15T10:30:00+00:00"
    }
  }
}
```

**Email relay** (`ALERT_WEBHOOK_TYPE=email`)

```json
{
  "to": "<ALERT_EMAIL_TO>",
  "subject": "VacciChain Anomaly Alert",
  "body": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

---

### Testing alerts in a non-production environment

1. **Use a low threshold** — set `ANOMALY_THRESHOLD=1` so any issuer with more than one mint triggers an alert.

2. **Use a short schedule** — set `ANOMALY_SCHEDULE_MINUTES=1` so you don't wait long.

3. **Slack**: create a free Slack app, add an Incoming Webhook, and paste the URL into `ALERT_WEBHOOK_URL`. Set `ALERT_WEBHOOK_TYPE=slack`.

4. **PagerDuty**: create a free developer account, add a service with the "Events API v2" integration, copy the routing key, and set `ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue`.

5. **Local HTTP sink**: run a simple listener (e.g. `python3 -m http.server 9999` or [webhook.site](https://webhook.site)) and point `ALERT_WEBHOOK_URL` at it to inspect raw payloads without sending real notifications.

6. **Trigger manually**: call `GET /analytics/anomalies` on the analytics service — the scheduler calls the same function, so the response confirms what would be flagged.

---

## Validation summary

| Variable | Required | Validated by | Rule |
|---|---|---|---|
| `STELLAR_NETWORK` | no | Zod (backend) | enum: `testnet` \| `mainnet` |
| `HORIZON_URL` | yes | Zod (backend) | valid URL |
| `SOROBAN_RPC_URL` | yes | Zod (backend) | valid URL |
| `SOROBAN_RPC_MAX_RETRIES` | no | Zod (backend) | non-negative integer, default 3 |
| `STELLAR_NETWORK_PASSPHRASE` | yes | Zod (backend) | non-empty string |
| `VACCINATIONS_CONTRACT_ID` | yes | Zod (backend) | non-empty string |
| `ADMIN_SECRET_KEY` | yes | Zod (backend) | non-empty string |
| `ADMIN_PUBLIC_KEY` | yes | runtime | valid Stellar public key format |
| `SEP10_SERVER_KEY` | yes | Zod (backend) | non-empty string |
| `ISSUER_SECRET_KEY` | yes | runtime | valid Stellar secret key format |
| `JWT_SECRET` | yes | Zod (backend) | non-empty string |
| `PORT` | no | Zod (backend) | positive integer, default 4000 |
| `ALLOWED_ORIGINS` | no | Zod (backend) | comma-separated URLs, default `http://localhost:3000` |
| `SOROBAN_FEE` | no | Zod (backend) | positive integer (stroops), default 100 |
| `SOROBAN_TIP` | no | Zod (backend) | non-negative integer (stroops), default 0 |
| `BODY_LIMIT` | no | Zod (backend) | size string, default `10kb` |
| `EVENT_POLL_INTERVAL_MS` | no | Zod (backend) | positive integer (ms), default 15000 |
| `TRUST_PROXY` | no | Zod (backend) | `false` \| `true` \| named range \| CIDR list \| hop count, default `false` |
| `DATABASE_PATH` | no | Zod (backend) | file path, default `/data/vaccichain.db` |
| `DATABASE_URL` | no | Zod (backend) | PostgreSQL URL; enables multi-writer backend |
| `DATABASE_POOL_SIZE` | no | Zod (backend) | positive integer, default 10 |
| `DATABASE_BUSY_TIMEOUT_MS` | no | Zod (backend) | positive integer (ms), default 5000 |
| `DATABASE_BACKUP_PATH` | no | runtime | writable directory; backups disabled if unset |
| `DATABASE_BACKUP_INTERVAL_MINUTES` | no | runtime | positive integer, default 60 |
| `VERIFY_MAX_RECORDS` | no | Zod (backend) | positive integer, default 100 |
| `VERIFY_MAX_BATCH_SIZE` | no | Zod (backend) | positive integer, default 50 |
| `VERIFY_MAX_PAGE_SIZE` | no | Zod (backend) | positive integer, default 100 |
| `RATE_LIMIT_SEP10` | no | runtime | parsed as integer, default 10 |
| `RATE_LIMIT_VERIFY` | no | runtime | parsed as integer, default 60 |
| `AUDIT_LOG_PATH` | no | runtime | writable path, default `./audit.log` |
| `AUDIT_LOG_MAX_BYTES` | no | runtime | positive integer (bytes), default 10485760 |
| `AUDIT_LOG_MAX_FILES` | no | runtime | positive integer, default 10 |
| `AUDIT_LOG_RETENTION_DAYS` | no | runtime | positive integer, default 90 |
| `AUDIT_LOG_INTEGRITY_KEY` | no | runtime | non-empty string; hash chaining only if unset |
| `AUDIT_LOG_VERIFY_ON_START` | no | runtime | boolean, default `true` |
| `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR` | no | runtime | boolean, default `false` |
| `AUDIT_LOG_FAILURE_MODE` | no | runtime | enum: `fail-closed` \| `fail-open`, default `fail-closed` |
| `ANALYTICS_PORT` | no | runtime | positive integer, default 8001 |
| `BACKEND_URL` | no | runtime | valid URL, default set by Compose |
| `LOG_LEVEL` | no | runtime | Python logging level, default `INFO` |
| `ANOMALY_THRESHOLD` | no | runtime | positive integer, default 50 |
| `ANOMALY_SCHEDULE_MINUTES` | no | runtime | positive integer, default 15 |
| `ALERT_WEBHOOK_URL` | no | runtime | valid HTTPS URL; alerts disabled if unset |
| `ALERT_WEBHOOK_TYPE` | no | runtime | enum: `slack` \| `pagerduty` \| `email`, default `slack` |
| `PAGERDUTY_ROUTING_KEY` | when type=pagerduty | runtime | 32-char hex string |
| `ALERT_EMAIL_TO` | when type=email | runtime | valid email address |
