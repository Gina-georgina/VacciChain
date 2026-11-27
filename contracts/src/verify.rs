//! Vaccination verification logic.
//!
//! # Batch verification limits
//!
//! `batch_verify` accepts at most [`MAX_BATCH_SIZE`] wallets per invocation.
//! The limit is validated up front, before any storage access, so an over-limit
//! request is rejected cheaply without consuming storage read resources.
//! Requests exceeding the limit return [`ContractError::BatchTooLarge`].

use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};
use crate::errors::ContractError;

/// Maximum number of wallets accepted by a single `batch_verify` invocation.
///
/// This bound keeps per-invocation resource usage (storage reads, CPU and
/// memory) predictable. It is validated before any storage access occurs.
pub const MAX_BATCH_SIZE: u32 = 100;

/// Storage lifecycle assumptions for verification.
///
/// - `DataKey::PatientTokens(wallet)` is a persistent entry holding the wallet's
///   token index. If it is absent (never written) or has expired (TTL elapsed),
///   the wallet is treated as having no records: verification returns
///   `(false, [], [])`. Absence of the index is never interpreted as
///   authorization.
/// - `DataKey::Token(tid)` is a persistent entry holding a `VaccinationRecord`.
///   If an individual token entry is missing or expired, it is skipped; the
///   remaining tokens are still evaluated. A missing token never counts as an
///   active (authorized) record.
/// - TTL extension is the responsibility of the write paths (e.g. record
///   issuance/revocation) which must call `extend_ttl` on both the token entry
///   and the patient index. Verification is read-only and does not extend TTLs,
///   so callers must not rely on a verify call to keep entries alive.
/// - Authorization never fails open: any missing/expired state yields a
///   non-authorized result (`has_active == false`), never `true`.
const _: () = ();

/// Distinguishes "wallet has no records" from "storage entry is missing or expired".
///
/// Returns `true` when the wallet's `PatientTokens` index entry is absent from
/// persistent storage (either never written or expired). In both cases the
/// caller must treat the wallet as unvaccinated; this helper exists only so
/// callers/tests can observe the difference between an empty index and a
/// missing/expired one.
pub fn patient_index_missing(env: &Env, wallet: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<u64>>(&DataKey::PatientTokens(wallet.clone()))
        .is_none()
}

/// Explicit outcome of a verification request.
///
/// Only `Valid` indicates an active vaccination record. `Revoked`, `Absent`,
/// and `Unavailable` must never be treated as a positive verification result.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationStatus {
    /// At least one active (non-revoked) record exists.
    Valid,
    /// Records exist but all are revoked.
    Revoked,
    /// No records exist for the wallet.
    Absent,
    /// The data could not be read; callers must NOT treat this as valid.
    Unavailable,
}

/// Per-vaccine dose completion summary returned by verify_vaccination.
#[contracttype]
#[derive(Clone)]
pub struct DoseStatus {
    /// The vaccine name for this dose summary.
    pub vaccine_name: String,
    /// Highest dose number received for this vaccine.
    pub doses_received: u32,
    /// Required total doses for this vaccine series.
    pub doses_required: u32,
    /// True when the required number of doses has been completed.
    pub complete: bool,
}

/// Batch verify vaccination status for multiple wallets.
///
/// This function is an optimized convenience wrapper for `verify_vaccination`.
/// It succeeds for up to `MAX_BATCH_SIZE` wallets and returns a tuple for each wallet:
/// `(wallet, status, records)`.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Ok(Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)>)` where the status
///   distinguishes valid, revoked, absent, and unavailable data. Only
///   `VerificationStatus::Valid` indicates an active vaccination record.
/// * `Err(ContractError::BatchTooLarge)` when `wallets.len() > MAX_BATCH_SIZE`.
///
/// The batch size is validated before any storage access is performed.
pub fn batch_verify(
    env: &Env,
    wallets: Vec<Address>,
) -> Result<Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)>, ContractError> {
    if wallets.len() > MAX_BATCH_SIZE {
        return Err(ContractError::BatchTooLarge);
    }

    let mut results: Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)> = Vec::new(env);
    for i in 0..wallets.len() {
        let wallet = wallets.get(i).unwrap();
        let (status, records, _) = verify_vaccination(env, wallet.clone());
        results.push_back((wallet, status, records));
    }
    Ok(results)
}

/// Verify vaccination status for a single wallet.
///
/// Returns an explicit `VerificationStatus`, the list of active (non-revoked)
/// vaccination records, and a per-vaccine dose completion summary.
///
/// The status distinguishes:
/// * `Valid` - at least one active record exists.
/// * `Revoked` - records exist but all are revoked.
/// * `Absent` - no records exist for the wallet.
/// * `Unavailable` - the data could not be read; callers must NOT treat this
///   as a positive verification result.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallet` - The wallet address to check.
///
/// # Returns
/// * `(VerificationStatus, Vec<VaccinationRecord>, Vec<DoseStatus>)`
///   - VerificationStatus: explicit outcome (never collapse failures into Valid)
///   - Vec<VaccinationRecord>: active vaccination records
///   - Vec<DoseStatus>: per-vaccine dose completion summary
pub fn verify_vaccination(env: &Env, wallet: Address) -> (VerificationStatus, Vec<VaccinationRecord>, Vec<DoseStatus>) {
    // Missing or expired patient index: treat as "no records". This is a
    // non-authorized result and must never be interpreted as authorized.
    let tokens: Vec<u64> = match env
        .storage()
        .persistent()
        .get::<DataKey, Vec<u64>>(&DataKey::PatientTokens(wallet.clone()))
    {
        Some(tokens) => tokens,
        None => return (VerificationStatus::Absent, Vec::new(env), Vec::new(env)),
    };

    if tokens.is_empty() {
        return (VerificationStatus::Absent, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<VaccinationRecord> = Vec::new(env);
    let mut has_active = false;
    let mut has_revoked = false;

    // Load all active (non-revoked) records for the wallet.
    // Missing or expired token entries are skipped explicitly: they are never
    // counted as active records, so authorization cannot fail open.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        match env
            .storage()
            .persistent()
            .get::<DataKey, VaccinationRecord>(&DataKey::Token(tid))
        {
            Some(record) => {
                if record.revoked {
                    has_revoked = true;
                } else {
                    has_active = true;
                    records.push_back(record);
                }
            }
            None => {
                // Token entry absent or expired; skip without granting access.
            }
        }
    }

    // Build per-vaccine dose status.
    // We track highest dose_number and highest dose_series seen for each vaccine.
    // Parallel vecs are used because a no_std map implementation is unavailable.
    let mut vaccine_names: Vec<String> = Vec::new(env);
    let mut doses_received: Vec<u32> = Vec::new(env);
    let mut doses_required: Vec<u32> = Vec::new(env);

    for i in 0..records.len() {
        let rec = records.get(i).unwrap();
        let dn = rec.dose_number.unwrap_or(0);
        let ds = rec.dose_series.unwrap_or(0);

        let mut found = false;
        for j in 0..vaccine_names.len() {
            if vaccine_names.get(j).unwrap() == rec.vaccine_name {
                let prev_dn = doses_received.get(j).unwrap();
                let prev_ds = doses_required.get(j).unwrap();
                if dn > prev_dn {
                    doses_received.set(j, dn);
                }
                if ds > prev_ds {
                    doses_required.set(j, ds);
                }
                found = true;
                break;
            }
        }
        if !found {
            vaccine_names.push_back(rec.vaccine_name.clone());
            doses_received.push_back(dn);
            doses_required.push_back(ds);
        }
    }

    let mut dose_statuses: Vec<DoseStatus> = Vec::new(env);
    for i in 0..vaccine_names.len() {
        let dr = doses_received.get(i).unwrap();
        let dq = doses_required.get(i).unwrap();
        dose_statuses.push_back(DoseStatus {
            vaccine_name: vaccine_names.get(i).unwrap(),
            doses_received: dr,
            doses_required: dq,
            complete: dq > 0 && dr >= dq,
        });
    }

    let status = if has_active {
        VerificationStatus::Valid
    } else if has_revoked {
        VerificationStatus::Revoked
    } else {
        VerificationStatus::Absent
    };

    (status, records, dose_statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn make_wallets(env: &Env, count: u32) -> Vec<Address> {
        let mut wallets: Vec<Address> = Vec::new(env);
        for _ in 0..count {
            wallets.push_back(Address::generate(env));
        }
        wallets
    }

    #[test]
    fn batch_verify_accepts_exactly_max_batch_size() {
        let env = Env::default();
        let wallets = make_wallets(&env, MAX_BATCH_SIZE);
        let result = batch_verify(&env, wallets);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), MAX_BATCH_SIZE);
    }

    #[test]
    fn batch_verify_rejects_over_limit_before_storage_access() {
        let env = Env::default();
        let wallets = make_wallets(&env, MAX_BATCH_SIZE + 1);
        let result = batch_verify(&env, wallets);
        assert_eq!(result, Err(ContractError::BatchTooLarge));
    }

    #[test]
    fn batch_verify_handles_mixed_results() {
        let env = Env::default();
        let mut wallets: Vec<Address> = Vec::new(&env);
        // Wallets without records should report not vaccinated.
        for _ in 0..3 {
            wallets.push_back(Address::generate(&env));
        }
        let result = batch_verify(&env, wallets).unwrap();
        assert_eq!(result.len(), 3);
        for i in 0..result.len() {
            let (_, status, records) = result.get(i).unwrap();
            assert_eq!(status, VerificationStatus::Absent);
            assert_eq!(records.len(), 0);
        }
    }

    #[test]
    fn batch_verify_empty_batch_is_ok() {
        let env = Env::default();
        let wallets: Vec<Address> = Vec::new(&env);
        let result = batch_verify(&env, wallets);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
}
