# API Reference — VacciChain

Base URL: `http://localhost:4000/v1`

This document lists primary endpoints, request/response schemas, authentication requirements, and examples.

## Authentication

- SEP-10 flow issues a JWT on successful verification.
- Include JWT as `Authorization: Bearer <token>` for protected endpoints.

---

## POST /auth/sep10

Generates a SEP-10 challenge transaction for the provided public key.

Request:
```json
{ "public_key": "G..." }
```

Response (200):
```json
{ "challenge": "<base64-xdr>" }
```

Errors:
- 400: missing or invalid `public_key`

---

## POST /auth/verify

Verify signed SEP-10 challenge and return JWT.

Request:
```json
{ "signed_xdr": "<base64-xdr>" }
```

Response (200):
```json
{ "token": "<jwt>", "expires_in": 3600 }
```

Errors:
- 401: invalid signature or expired challenge

---

## POST /vaccination/issue

Mint a vaccination NFT for a patient. Issuer-only action.

Headers:
- `Authorization: Bearer <issuer_jwt>`

Request body:
```json
{
  "patient_wallet": "G...",
  "vaccine": "COVID-19",
  "date": "2026-05-01",
  "batch": "BATCH-123",
  "metadata": { "lot": "L-123" }
}
```

Response (201):
```json
{
  "token_id": "abc123",
  "contract_tx": "<hash>",
  "issued_at": "2026-05-01T12:34:56Z"
}
```

Errors:
- 400: validation error (missing fields)
- 403: issuer not authorized
- 409: duplicate record detected

---

## GET /vaccination/:wallet

Fetch all vaccination records for a wallet.

Response (200):
```json
{
  "wallet": "G...",
  "records": [
    { "token_id": "abc123", "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." }
  ]
}
```

Errors:
- 404: wallet not found (no records)

---

## GET /verify/:wallet

Public endpoint returning aggregated verification result.

The response always includes a `status` field that distinguishes the four possible data states. Clients MUST branch on `status` and MUST NOT treat `verified` alone as a medical determination.

| `status` | Meaning | `verified` | Interpretation |
|----------|---------|------------|----------------|
| `valid` | All expected records are present and none are revoked. | `true` | Records exist and are currently valid. |
| `revoked` | One or more records exist but have been revoked on-chain. | `false` | Do not treat as verified; revoked records are not valid. |
| `absent` | The wallet has no vaccination records. | `false` | No determination can be made. |
| `unavailable` | Records could not be retrieved (RPC/contract failure, timeout, or indexer error). | `false` | Unknown state — MUST NOT be interpreted as valid verification. |

Response (200) — valid:
```json
{
  "wallet": "G...",
  "status": "valid",
  "verified": true,
  "records": [ { "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." } ]
}
```

Response (200) — revoked:
```json
{
  "wallet": "G...",
  "status": "revoked",
  "verified": false,
  "records": [ { "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G...", "revoked": true } ]
}
```

Response (200) — absent:
```json
{ "wallet": "G...", "status": "absent", "verified": false, "records": [] }
```

Response (200) — unavailable:
```json
{ "wallet": "G...", "status": "unavailable", "verified": false, "records": [] }
```

Errors:
- 400: malformed wallet address

> **Rule:** An RPC or contract failure MUST NOT be collapsed into a positive verification result. When data cannot be retrieved, the endpoint returns `status: "unavailable"` with `verified: false`; it never returns `verified: true` for missing, revoked, or unavailable data. This endpoint reports record state only and is not a medical determination.

---

## Verifier API Keys

Third-party verifiers authenticate with an API key instead of a JWT. Keys are
provisioned by an admin, individually scoped, rotatable, and revocable.

### Key format and storage

- Keys are returned **once** at creation time in the form `vck_<prefix>_<secret>`.
- Only a verifiable hash of the secret is stored server-side; the plaintext key is
  never persisted or retrievable again.
- The `<prefix>` portion is stored in clear text so keys can be identified in
  audit logs without exposing the secret.

### Header contract

Send the key on every verifier request:

```
X-API-Key: vck_<prefix>_<secret>
```

Errors:
- 401: missing, malformed, unknown, revoked, or expired key
- 403: key is valid but lacks the scope required by the endpoint

### Scopes

Each key is created with an explicit list of scopes. Supported scopes:

| Scope | Grants access to |
| --- | --- |
| `verify:read` | `GET /verify/:wallet` |
| `records:read` | `GET /vaccination/:wallet` |
| `records:write` | `POST /vaccination/issue` (issuer keys only) |

Requests to endpoints outside the key's scopes return `403`.

### Lifecycle

1. **Provision** — an admin creates a key with a label and scopes. The plaintext
   key is returned in the response and must be stored by the verifier.
2. **Rotate** — an admin rotates a key, producing a new secret. The previous
   secret remains valid until the end of the configured grace period (default
   24 hours), after which it stops authenticating.
3. **Revoke** — an admin revokes a key immediately. Revoked keys fail with `401`
   and cannot be reactivated; provision a new key instead.

### Audit events

Every lifecycle action and authentication failure is recorded with the key
prefix, actor, timestamp, and outcome. Emitted events:

- `api_key.created`
- `api_key.rotated`
- `api_key.revoked`
- `api_key.auth_failed` (reason: `unknown`, `revoked`, `expired`, `scope_denied`)

---

## POST /admin/api-keys

Provision a new verifier API key. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Request:
```json
{
  "label": "Clinic A verifier",
  "scopes": ["verify:read", "records:read"]
}
```

Response (201):
```json
{
  "id": "key_01H...",
  "prefix": "vck_ab12cd",
  "api_key": "vck_ab12cd_<secret>",
  "scopes": ["verify:read", "records:read"],
  "created_at": "2026-05-01T12:34:56Z"
}
```

Errors:
- 400: missing label or unknown scope
- 403: caller is not an admin

---

## POST /admin/api-keys/:id/rotate

Rotate the secret for an existing key. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Request:
```json
{ "grace_period_seconds": 86400 }
```

Response (200):
```json
{
  "id": "key_01H...",
  "prefix": "vck_ab12cd",
  "api_key": "vck_ab12cd_<new_secret>",
  "previous_valid_until": "2026-05-02T12:34:56Z"
}
```

Errors:
- 404: key not found
- 409: key is revoked

---

## DELETE /admin/api-keys/:id

Revoke a key immediately. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Response (204): no body.

Errors:
- 404: key not found

---

## Analytics (Python service)

Base URL: `http://localhost:8001`

### GET /analytics/rates
Response:
```json
{ "by_vaccine": { "COVID-19": 1234 } }
```

### POST /batch/verify
Request: `{"wallets": ["G...", "G..."]}`
Response: `{"results": [{"wallet":"G...","status":"valid","verified":true}]}`

Each result carries the same `status` enum as `GET /verify/:wallet` (`valid`, `revoked`, `absent`, `unavailable`). Entries with `status: "unavailable"` indicate a retrieval failure and MUST NOT be interpreted as valid verification.

---

For full endpoint listings, examples, and error codes, see the `backend/src/routes` implementations and expand this document as needed.
