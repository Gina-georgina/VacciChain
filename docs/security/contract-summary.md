# VacciChain Contract — Audit-Ready Summary

**Version:** 0.2.0  
**Date:** 2026-05-12  
**Language:** Rust (Soroban SDK 22.0.0)  
**Network:** Stellar (Soroban smart contracts)  
**Lines of code:** ~500 (excluding tests and comments)

**Pinned source revision (audit target):** `git rev-parse HEAD` at engagement start —
recorded in `docs/security/audit-scope.md` together with the reproducible build command.
**WASM hash (audit target):** SHA-256 of the release build artifact, recorded in
`docs/security/audit-scope.md` and re-verified against the deployed contract before
mainnet approval.

> Prepared for external auditors. All pre-audit findings have been resolved; see
> `docs/security/pre-audit-notes.md` for the resolution record and
> `docs/security/audit-scope.md` for scope, pinned revision, WASM hash, and findings.
> Critical and high findings must be fixed and independently verified before mainnet
> approval.

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
| `mint_vaccination(patient, vaccine_name, date_administered, issuer)` | Mints soulbound NFT. Checks patient allowlist, issuer authorization, duplicate detection, per-patient record limit (50), and input length bounds (see §5.1). Returns `token_id`. |
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

### 5.1 Input and Collection Bound Policy

All variable-length inputs and collections are bounded on-chain. Exceeding a bound
returns a structured contract error; no path panics on user-controlled input.

| Input / collection | Bound | Enforcement |
|---|---|---|
| `vaccine_name` | 100 chars | `mint_vaccination` rejects oversized input |
| `date_administered` | 100 chars | `mint_vaccination` rejects oversized input |
| `IssuerRecord.name` / `.license` / `.country` | 100 chars each | `add_issuer` rejects oversized input |
| Records per patient (`PatientTokens`) | 50 | `mint_vaccination` returns structured error |
| `batch_verify` wallet list | 100 wallets | `batch_verify` returns structured error |
| `get_all_issuers` page size | caller-supplied `limit` | paginated read, no unbounded iteration |

### 5.2 Privacy-Safe Field Classification

On-chain state is immutable and publicly readable. Every field is classified below;
personally identifying and clinically sensitive data are excluded by policy. See
`docs/security/privacy-review.md` for the privacy review sign-off and residual
linkability analysis.

| Field | Classification | Rationale |
|---|---|---|
| `token_id` | Public identifier | Opaque sequential ID; no personal meaning |
| `patient` (Address) | Pseudonymous identifier | Wallet address only; no name or contact data |
| `vaccine_name` | Sensitive-but-required | Minimum clinical detail needed for verification |
| `date_administered` | Sensitive-but-required | Minimum clinical detail needed for verification |
| `issuer` (Address) | Public identifier | Provider wallet address |
| `timestamp` | Public metadata | Ledger time of mint |
| `schema_version` | Public metadata | Schema evolution |
| `revoked` | Public metadata | Verification status |
| `IssuerRecord.name` / `.license` / `.country` | Public provider metadata | Organizational, not patient, data |

**Excluded by policy (must never be written on-chain):** patient names, dates of birth,
contact details (email, phone, address), national ID numbers, insurance identifiers,
free-text clinical notes, and any field not listed above. Residual linkability risk
(wallet addresses are persistent pseudonyms and can be correlated across records) is
documented and accepted in the privacy review.

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
IssuerMeta(Address)          → IssuerRecord
IssuerList                   → Vec<Address>
NextTokenId                  → u64
PatientRecordLimit           → u32
```

> **Note:** All keys used in the source are present in the `DataKey` enum. Persistent
> storage TTL is extended on every write path.

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

### 6.1 Soulbound Enforcement Matrix

| Path | Transfer allowed? | Enforcement |
|---|---|---|
| `transfer(from, to, token_id)` | No | Always returns `SoulboundToken` error |
| Record reassignment via `mint_vaccination` | No | `PatientTokens` is append-only per patient; records are never moved |
| `revoke_vaccination` | N/A | Marks `revoked = true`; record and ownership are never deleted or reassigned |
| Direct storage write | No | No public function mutates `Token`/`PatientTokens` ownership |

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
   The backend signs this with the patient's own key; the earlier `ADMIN_SECRET_KEY`
   placeholder has been removed.

4. **On-chain data is public.** All vaccination records, issuer lists, and patient wallet
   addresses are readable by anyone. There is no privacy layer; the on-chain schema is
   minimized per the field classification in §5.2 and residual linkability risk is
   documented in the privacy review.

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

## 8. Resolved Pre-Audit Findings

All previously documented pre-audit issues have been fixed and covered by tests. See
`docs/security/pre-audit-notes.md` for the resolution record.

| Issue | Resolution |
|---|---|
| Contract did not compile (15 errors) | `DataKey` enum completed; contract builds cleanly |
| `is_issuer` always returned false (key mismatch) | Storage key usage aligned; covered by tests |
| `batch_verify` panicked on oversized input | Returns structured error; bound documented in §5.1 |
| Record limit exceeded panicked | Returns structured error; bound documented in §5.1 |
| Persistent storage TTL never extended | TTL extended on every write path |
| `emit_issuer_revoked` never called | `revoke_issuer` now emits `iss_rev` |
| Event schemas not versioned in emitted topics | Schemas now versioned; indexers can distinguish payload versions after upgrade (see §9) |
| No reproducible build pipeline | Reproducible build pipeline added; release WASM hash can be independently verified (see §11) |

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

> **Note:** `revoke_issuer` emits `iss_rev` via `emit_issuer_revoked`.

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
- Input validation completeness, including batch size limits (§4) and the input/collection bound policy (§5.1)
- Privacy-safe field classification and on-chain schema minimization (§5.2)
- Soulbound enforcement across all paths (§6.1)
- Event emission correctness, completeness, and schema versioning (§9)
- Reproducible build process and artifact hash verification (§10)
- Soroban-specific concerns: storage TTL extension, auth model, host function usage
- Storage growth, archival, and migration test coverage (see §5)
- Contract lifecycle and upgrade authorization

The pinned source revision and WASM hash under audit are recorded in
`docs/security/audit-scope.md`. Critical and high findings must be fixed and
independently verified before mainnet approval.

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
