import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useFreighter';

/**
 * useConsent — manages patient consent state.
 *
 * Returns:
 *   consented      — null (unknown), true, or false
 *   checkConsent() — fetch consent status for the connected wallet
 *   giveConsent()  — POST consent and update state
 *   loading        — true while a request is in flight
 */
export function useConsent() {
  const { publicKey, apiFetch } = useAuth();
  const [consented, setConsented] = useState(null);
  const [loading, setLoading] = useState(false);
  // Tracks the wallet whose consent state is currently reflected in `consented`.
  const activeWalletRef = useRef(null);

  const checkConsent = useCallback(async (wallet) => {
    if (!wallet) return;
    // Ignore results for a wallet that is no longer active.
    if (wallet !== activeWalletRef.current) return null;
    setLoading(true);
    try {
      const res = await apiFetch(`/v1/patient/consent/${wallet}`);
      const data = await res.json();
      if (wallet !== activeWalletRef.current) return null;
      setConsented(data.consented);
      return data.consented;
    } catch {
      return null;
    } finally {
      if (wallet === activeWalletRef.current) setLoading(false);
    }
  }, [apiFetch]);

  // Clear wallet-specific state and re-check consent whenever the active
  // account changes or the wallet disconnects.
  useEffect(() => {
    activeWalletRef.current = publicKey || null;
    setConsented(null);
    setLoading(false);
    if (publicKey) {
      checkConsent(publicKey);
    }
  }, [publicKey, checkConsent]);

  const giveConsent = useCallback(async () => {
    if (!publicKey) return false;
    const wallet = publicKey;
    setLoading(true);
    try {
      const res = await apiFetch('/v1/patient/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      if (wallet !== activeWalletRef.current) return false;
      if (res.ok) {
        setConsented(true);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (wallet === activeWalletRef.current) setLoading(false);
    }
  }, [publicKey, apiFetch]);

  return { consented, checkConsent, giveConsent, loading };
}
