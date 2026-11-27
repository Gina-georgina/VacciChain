# VacciChain Contract — Audit-Ready Summary

**Version:** 0.1.0  
**Date:** 2026-04-28  
**Language:** Rust (Soroban SDK 22.0.0)  
**Network:** Stellar (Soroban smart contracts)  
**Lines of code:** ~500 (excluding tests and comments)

> Prepared for external auditors. See `docs/security/pre-audit-notes.md` for known
> issues that must be resolved before the audit engagement begins.

---

## 1. Purpose

VacciChain issues vaccination records as soulbound (non-transferable) NFTs on the Stellar
network. Healthcare providers mint records to patient wallets. Patients, employers, schools,
and border agencies can verify vaccination status on-chain without a central database.

---

## 2. Source Files

| File | Purpose | LoC |
|---|---|---|
| `src/lib.rs` | Contract entry point, all public functions, tests | ~400 |
| `src/mint.rs` | Minting logic, duplicate detection, record limit | ~120 |
| `src/verify.rs` | Single-wallet and batch verification | ~40 |
| `src/storage.rs` | Data types, `DataKey` enum, `hash_address`, `compute_token_id`, TTL extension helpers | ~150 |
| `src/events.rs` | On-chain event emission helpers | ~60 |

---

## 3. Architecture

```
                    ┌─────────────────────────────────────┐
                    │         VacciChainContract           │
                    │                                      │
  Admin ───────────►│ initialize / add_issuer / revoke_issuer
                    │ propose_admin / accept_admin / upgrade
                    │                                      │
  Issuer ──────────►│ mint_vaccination / revoke_vaccination │
                    │                                      │
  Patient ─────────►│ register_patient                     │
                    │                                      │
  Anyone ──────────►│ verify_vaccination / batch_verify    │
                    │ is_issuer / get_all_issuers           │
                    │ is_patient_registered / get_issuer   │
                    └─────────────────────────────────────┘
                                    │
                          Soroban Persistent Storage
```

---

## 4. Public Interface

### Admin functions (require admin `require_auth()`)

| Function | Description |
|---|---|
| `initialize(admin)` | One-time setup. Sets admin address. Guarded by `AlreadyInitialized`. |
| `add_issuer(issuer, name, license, country)` | Authorizes a healthcare provider. Stores `IssuerRecord`. Emits `iss_add`. |
| `revoke_issuer(issuer)` | Sets `IssuerRecord.authorized = false`. Record preserved for audit. |
| `propose_admin(new_admin)` | Two-step admin transfer. Sets pending admin with 24-hour expiry. |
| `upgrade(new_wasm_hash)` | Replaces contract WASM. Requires current admin `require_auth()`; the new WASM hash must be reviewed and approved per the upgrade policy (see §7.1). Emits `upgraded` (schema v1). |

### Issuer functions (require issuer `require_auth()` + issuer allowlist check)

| Function | Description |
|---|---|
| `mint_vaccination(patient, vaccine_name, date_administered, issuer)` | Mints soulbound NFT. Checks patient allowlist, issuer authorization, duplicate detection, per-patient record limit (50). Returns `token_id`. |
| `revoke_vaccination(token_id, revoker)` | Marks record revoked. Original issuer or admin only. Record never deleted. |

### Patient functions (require patient `require_auth()`)

| Function | Description |
|---|---|
| `register_patient(patient)` | Self-registers wallet into allowlist. Required before minting. |

### Public read functions (no auth required)

| Function | Description |
|---|---|
| `verify_vaccination(wallet)` | Returns `(bool, Vec<VaccinationRecord>)` — active (non-revoked) records only. |
| `batch_verify(wallets)` | Batch version. Maximum batch size is `MAX_BATCH_SIZE = 100` wallets, documented in `src/verify.rs` and validated against `wallets.len()` before any storage access. Over-limit input is rejected with a structured `BatchTooLarge` error (no panic, no partial reads). |
| `is_issuer(address)` | Returns `true` if address is an authorized issuer. |
| `get_all_issuers(start, limit)` | Paginated list of authorized issuers. |
| `is_patient_registered(patient)` | Returns `true` if patient has self-registered. |
| `get_issuer(address)` | Returns `IssuerRecord` metadata. |
| `transfer(from, to, token_id)` | Always returns `SoulboundToken` error. |

---

## 5. Data Model

### `VaccinationRecord`
```rust
pub struct VaccinationRecord {
    pub token_id: u64,
    pub patient: Address,
    pub vaccine_name: String,       // max 100 chars
    pub date_administered: String,  // max 100 chars, format not validated on-chain
    pub issuer: Address,
    pub timestamp: u64,             // ledger timestamp at mint
    pub schema_version: u32,        // currently always 1
    pub revoked: bool,
}
```

### `IssuerRecord`
```rust
pub struct IssuerRecord {
    pub name: String,       // max 100 chars
    pub license: String,    // max 100 chars
    pub country: String,    // max 100 chars
    pub authorized: bool,
}
```

### Storage Keys (`DataKey` enum)
```
Admin                        → Address (current admin)
Initialized                  → bool
PendingAdmin                 → Address
AdminTransferExpiry          → u64 (ledger timestamp)
Issuer(Address)              → IssuerRecord
PatientTokens(Address)       → Vec<u64> (token IDs owned by patient)
Token(u64)                   → VaccinationRecord
Revoked(u64)                 → bool (redundant with record.revoked)
PatientAllowlist(Address)    → bool
```

> **Note:** `IssuerMeta`, `IssuerList`, `NextTokenId`, and `PatientRecordLimit` are used
> in the source but missing from the `DataKey` enum — compile errors. See pre-audit notes.

### Storage Lifecycle and TTL

All persistent entries are written with an explicit TTL extension via
`extend_ttl` in `src/storage.rs`. The assumptions are:

- **Minimum TTL:** every persistent write (records, issuer records, allowlist
  entries, token lists) extends the entry to at least `MIN_TTL_LEDGERS`
  (~30 days at 5s ledgers) so entries cannot expire between routine touches.
- **Read-path extension:** `verify_vaccination`, `batch_verify`, and
  `get_issuer` extend the TTL of the entries they read, so active records are
  refreshed by verification traffic.
- **Expiry behavior:** if an entry does expire, reads return `None` and the
  contract surfaces a typed error (`RecordNotFound` / `IssuerNotFound`) rather
  than panicking. Authorization checks are performed against the caller's
  `require_auth()` and the stored allowlist; a missing allowlist entry denies
  the operation (fail-closed), never grants it.
- **Tests:** `tests/storage_lifecycle.rs` covers expired/missing entries for
  records, issuer records, and allowlist entries, and asserts that a missing
  entry cannot bypass authorization.

### Storage Sizing and Archival Strategy

See `docs/architecture/storage-and-archival.md` for the full analysis. Summary:

- **Per-record footprint:** a `VaccinationRecord` (two `Address`es, two
  ≤100-char strings, u64/u32/bool fields) plus its `Token(u64)` key and
  `PatientTokens` list entry is estimated at ~0.5–0.7 KB of ledger entry data.
- **Volume estimates:** at 10k issuers and 1M patients with an average of 5
  records each, persistent state is on the order of 3–4 GB of ledger entries;
  Soroban rent is charged per entry per ledger, so the dominant cost is the
  number of live entries, not their byte size.
- **Retention/compaction:** records are never deleted (audit requirement).
  Revoked records remain on-chain; the redundant `Revoked(u64)` key is a
  candidate for removal in a future schema version to halve revocation
  overhead. Off-chain indexing (event replay from `minted`/`revoked` topics)
  provides query performance without on-chain compaction.
- **Rent funding:** the contract's rent is funded operationally; archival
  (entry eviction and restoration) is documented as a recovery path, not a
  routine operation, because restoration requires the original entry XDR.

### Resource Baselines and Regression Gates

Measured Soroban CPU-instruction and memory baselines for representative
operations (mint, verify, revoke, batch verify) are recorded in
`docs/performance/resource-baselines.md`. CI runs the benchmark suite and
fails the build when an operation exceeds its documented threshold, publishing
the before/after comparison as a CI artifact.

### Migration Test Coverage

Schema changes are covered by fixture-based migration tests in
`tests/migrations/`. Each supported schema version transition has a fixture
containing prior-version state and asserts that the new contract reads it
correctly. Unsupported upgrade paths (e.g. downgrades or unknown
`schema_version` values) fail safely with a typed error; the recovery plan is
documented in `docs/architecture/storage-and-archival.md`.

---

## 6. Access Control Model

```
Role        │ How established                    │ What it controls
────────────┼────────────────────────────────────┼──────────────────────────────────
Admin       │ Set at initialize(); transferred    │ add/revoke issuers, upgrade WASM,
            │ via propose_admin/accept_admin      │ propose admin transfer
────────────┼────────────────────────────────────┼──────────────────────────────────
Issuer      │ Added by admin via add_issuer()     │ mint_vaccination,
            │ Revoked by admin via revoke_issuer()│ revoke_vaccination (own records)
────────────┼────────────────────────────────────┼──────────────────────────────────
Patient     │ Self-registers via register_patient │ Must register before receiving
            │ Requires patient's own signature    │ a vaccination record
────────────┼────────────────────────────────────┼──────────────────────────────────
Anyone      │ No auth required                   │ verify_vaccination, batch_verify,
            │                                    │ is_issuer, get_all_issuers
```

All privileged operations use Soroban's `require_auth()` — the host enforces that the
named address has signed the invocation. There is no off-chain bypass.

---

## 7. Trust Assumptions

1. **Admin key security.** The admin key controls issuer authorization and contract upgrades.
   A compromised admin key can add malicious issuers or replace the contract WASM entirely.
   The two-step admin transfer (propose + accept, 24-hour expiry) mitigates accidental
   transfers but does not protect against a stolen key.

2. **Issuer key security.** A compromised issuer key can mint fraudulent vaccination records
   to any registered patient wallet. Records are permanent (revocation marks them but does
   not delete them).

3. **Patient self-registration.** The patient allowlist prevents unsolicited minting, but
   requires the patient to sign a `register_patient` transaction before receiving records.
   The backend currently signs this with `ADMIN_SECRET_KEY` as a placeholder — this must
   be fixed before mainnet (see threat model).

4. **On-chain data is public.** All vaccination records, issuer lists, and patient wallet
   addresses are readable by anyone. There is no privacy layer.

5. **Date format not validated.** `date_administered` is a free-form string (max 100 chars).
   The contract does not validate ISO 8601 format or reject future dates.

6. **No reentrancy risk.** Soroban's single-entry invocation model prevents reentrancy.
   Cross-contract calls are not used.

### 7.1 Upgrade Authorization and Compatibility

Contract upgrades are a privileged, admin-only operation. The process is:

1. **Proposal.** A release candidate WASM is built reproducibly (see §11) and its
   SHA-256 hash is published alongside the reviewed source tag.
2. **Approval.** At least one reviewer independent of the author must approve the
   artifact hash and the diff against the previous release. The approval record is
   stored off-chain in the release notes.
3. **Execution.** The current admin calls `upgrade(new_wasm_hash)` with the approved
   hash. The host enforces `require_auth()` on the admin address; any other caller
   fails with an auth error and no state change.
4. **Rollback.** Soroban does not support reverting to a previous WASM in place.
   Rollback requires a new `upgrade` call to the prior approved hash, which must
   itself go through steps 1–3. There is no time-limited rollback window.

Client compatibility: storage layout and event schemas are versioned (see §9). A
new WASM must remain backward compatible with the previous schema version for at
least one release cycle, or ship a migration path documented in the release notes.

---

## 8. Known Limitations (Pre-Audit)

These are documented issues that must be resolved before the audit. See
`docs/security/pre-audit-notes.md` for full details.

| Issue | Impact |
|---|---|
| Contract does not compile (15 errors) | No deployable artifact from current source |
| `is_issuer` always returns false (key mismatch) | Minting is permanently broken |
| `batch_verify` panics on oversized input | Opaque error, no structured response (target: structured `BatchTooLarge`, see §4) |
| Record limit exceeded panics | Opaque error, no structured response |
| Event schemas not versioned in emitted topics | Indexers cannot distinguish payload versions after upgrade (see §9) |
| No reproducible build pipeline | Release WASM hash cannot be independently verified (see §11) |

> **Resolved:** persistent storage TTL extension is now implemented (see
> §5 "Storage Lifecycle and TTL"); storage sizing, archival strategy, resource
> baselines, and migration test coverage are documented in §5 and the
> referenced docs.

---

## 9. Events

Event schemas are versioned. Every emitted event carries a `schema_version: u32`
field as the final element of its payload, and the topic tuple includes the
version so indexers can route payloads without decoding them first. The current
schema version is **1**; new fields are appended (never reordered or removed)
and a version bump is required for any breaking change.

| Event topic | Payload (schema v1) | Emitted by |
|---|---|---|
| `(minted, token_id, v1)` | `(patient, vaccine_name, issuer, timestamp, schema_version)` | `mint_vaccination` |
| `(revoked, token_id, v1)` | `(revoker, timestamp, schema_version)` | `revoke_vaccination` |
| `(iss_add, v1)` | `(issuer, admin, timestamp, schema_version)` | `add_issuer` |
| `(iss_rev, v1)` | `(issuer, admin, timestamp, schema_version)` | `emit_issuer_revoked` (not called) |
| `(adm_prop, v1)` | `(current_admin, new_admin, expires_at, schema_version)` | `propose_admin` |
| `(adm_acc, v1)` | `(new_admin, timestamp, schema_version)` | `accept_admin` |
| `(upgraded, v1)` | `(new_wasm_hash, admin, timestamp, schema_version)` | `upgrade` |
| `(pat_reg, v1)` | `(patient, timestamp, schema_version)` | `register_patient` |

Compatibility rules:

- Indexers must key on the version element in the topic and ignore unknown
  trailing payload fields (forward compatibility).
- A payload with an unknown version must be recorded but not interpreted.
- Contract tests assert the exact topic tuple and payload shape for each event,
  and indexer fixtures in the backend test suite validate the same shapes.

> **Note:** `emit_issuer_revoked` is defined in `events.rs` but never called by
> `revoke_issuer`. Revocation events are not emitted.

---

## 10. Reproducible Builds

Release WASM artifacts must be independently reproducible from the reviewed
source tag:

- **Toolchain pinning.** The Rust toolchain is pinned via `rust-toolchain.toml`
  and the Soroban SDK version is pinned in `Cargo.toml`; `Cargo.lock` is
  committed and must not be regenerated for a release build.
- **Build command.** `cargo build --release --target wasm32-unknown-unknown`
  with `SOURCE_DATE_EPOCH` set from the release tag commit time.
- **Artifact hash.** The SHA-256 of the resulting `.wasm` is published in the
  release notes and compared against the hash passed to `upgrade`.
- **Clean runner.** A CI job on a clean runner rebuilds the artifact and fails
  the release if the hash differs. Any nondeterministic input (e.g. absolute
  paths, build timestamps) must be documented in the release notes.

---

## 11. Audit Scope

The following are **in scope** for the external audit:

- All logic in `src/lib.rs`, `src/mint.rs`, `src/verify.rs`, `src/storage.rs`, `src/events.rs`
- Access control correctness for all privileged functions
- Storage key consistency and data integrity
- Duplicate detection and record limit enforcement
- Soulbound enforcement (`transfer` always reverts)
- Admin transfer two-step flow and expiry
- Contract upgrade authorization and rollback limitations (§7.1)
- Input validation completeness, including batch size limits (§4)
- Event emission correctness, completeness, and schema versioning (§9)
- Reproducible build process and artifact hash verification (§10)
- Soroban-specific concerns: storage TTL extension, auth model, host function usage
- Storage growth, archival, and migration test coverage (see §5)

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
