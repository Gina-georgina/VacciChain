import { useState, useCallback } from 'react';
import { useAuth } from './useFreighter';

/**
 * useConsent — manages patient consent state.
 *
 * The authoritative source of truth is always the API; local state is only a
 * cache of the last confirmed response and is refreshed after every mutation.
 *
 * Returns:
 *   consented      — null (unknown), true, or false
 *   consentStatus  — { consented, scope, updatedAt } or null when unknown
 *   checkConsent() — fetch consent status for the connected wallet
 *   refreshConsent() — refetch authoritative consent state for the wallet
 *   giveConsent()  — POST consent, then refetch authoritative state
 *   revokeConsent() — POST revocation, then refetch authoritative state
 *   loading        — true while a request is in flight
 *   error          — last error message, or null
 */
export function useConsent() {
  const { publicKey, apiFetch } = useAuth();
  const [consented, setConsented] = useState(null);
  const [consentStatus, setConsentStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const applyStatus = useCallback((data) => {
    const status = {
      consented: data?.consented ?? null,
      scope: data?.scope ?? null,
      updatedAt: data?.updatedAt ?? null,
    };
    setConsentStatus(status);
    setConsented(status.consented);
    return status;
  }, []);

  const refreshConsent = useCallback(async (wallet) => {
    const target = wallet || publicKey;
    if (!target) return null;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/patient/consent/${target}`);
      if (!res.ok) {
        throw new Error(`Failed to load consent (${res.status})`);
      }
      const data = await res.json();
      return applyStatus(data);
    } catch (err) {
      setError(err?.message || 'Failed to load consent');
      return null;
    } finally {
      setLoading(false);
    }
  }, [apiFetch, publicKey, applyStatus]);

  const checkConsent = useCallback(async (wallet) => {
    const status = await refreshConsent(wallet);
    return status ? status.consented : null;
  }, [refreshConsent]);

  const giveConsent = useCallback(async () => {
    if (!publicKey) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/v1/patient/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey }),
      });
      if (!res.ok) {
        throw new Error(`Failed to update consent (${res.status})`);
      }
    } catch (err) {
      setError(err?.message || 'Failed to update consent');
      return false;
    } finally {
      setLoading(false);
    }
    // Never trust the mutation response alone — refetch authoritative state.
    const status = await refreshConsent(publicKey);
    return status ? status.consented === true : false;
  }, [publicKey, apiFetch, refreshConsent]);

  const revokeConsent = useCallback(async () => {
    if (!publicKey) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/v1/patient/consent/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey }),
      });
      if (!res.ok) {
        throw new Error(`Failed to revoke consent (${res.status})`);
      }
    } catch (err) {
      setError(err?.message || 'Failed to revoke consent');
      // Still attempt to reconcile with the authoritative state.
      await refreshConsent(publicKey);
      return false;
    } finally {
      setLoading(false);
    }
    const status = await refreshConsent(publicKey);
    return status ? status.consented === false : false;
  }, [publicKey, apiFetch, refreshConsent]);

  return {
    consented,
    consentStatus,
    checkConsent,
    refreshConsent,
    giveConsent,
    revokeConsent,
    loading,
    error,
  };
}
