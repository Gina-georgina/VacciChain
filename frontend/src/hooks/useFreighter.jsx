import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  isConnected,
  getPublicKey,
  signTransaction,
} from '@stellar/freighter-api';
import { useToast } from './useToast';

const AuthContext = createContext(null);
// Only persist publicKey and role — token is kept in memory only
const STORAGE_KEY = 'vaccichain_wallet';
// Cache keys for private records that must be invalidated on wallet lifecycle changes
const PRIVATE_CACHE_KEYS = ['vaccichain_vaccination_cache'];
// How often to poll Freighter for account/disconnect changes (ms)
const WALLET_POLL_INTERVAL = 3000;

function clearPrivateCaches() {
  if (typeof window === 'undefined') return;
  PRIVATE_CACHE_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore storage errors
    }
  });
}

export function AuthProvider({ children }) {
  const toast = useToast();
  const [publicKey, setPublicKey] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [freighterInstalled, setFreighterInstalled] = useState(() => typeof window !== 'undefined' && !!window.freighter);
  // Token lives only in memory — never written to localStorage
  const tokenRef = useRef(null);
  // Increments whenever the active account changes or the wallet disconnects,
  // so consumers can key data loads on the active account.
  const [walletChangeCounter, setWalletChangeCounter] = useState(0);
  // AbortController for in-flight requests; aborted on disconnect/account change
  const abortRef = useRef(null);
  // Tracks the account we believe is active, to detect changes during polling
  const activeKeyRef = useRef(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const clearWalletState = useCallback(() => {
    abortInFlight();
    setPublicKey(null);
    tokenRef.current = null;
    activeKeyRef.current = null;
    setRole(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
    clearPrivateCaches();
    setWalletChangeCounter((c) => c + 1);
  }, [abortInFlight]);

  const runSep10 = useCallback(async (pk) => {
    const challengeRes = await fetch('/v1/auth/sep10', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: pk }),
    });
    const { transaction, nonce } = await challengeRes.json();
    const signedXDR = await signTransaction(transaction, { network: 'TESTNET' });
    const verifyRes = await fetch('/v1/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXDR, nonce }),
    });
    const data = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(data.error);
    return data;
  }, []);

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const connected = await isConnected();
      if (!connected) {
        setFreighterInstalled(false);
        throw new Error('Freighter wallet not found. Please install it.');
      }
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      setPublicKey(pk);
      activeKeyRef.current = pk;
      tokenRef.current = data.token;
      setRole(data.role);
      // Persist only publicKey and role — not the token
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ publicKey: pk, role: data.role }));
      setWalletChangeCounter((c) => c + 1);
      toast('Wallet connected.', 'success');
      return data;
    } catch (e) {
      const msg = e.message || 'Failed to connect wallet.';
      setError(msg);
      toast(msg, 'error');
      throw e;
    } finally {
      setLoading(false);
    }
  }, [runSep10, toast]);

  const disconnect = useCallback(() => {
    clearWalletState();
  }, [clearWalletState]);

  // On mount: restore publicKey/role from localStorage, but require a fresh SEP-10 for the token
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const { publicKey: savedKey, role: savedRole } = JSON.parse(saved);
    isConnected().then((connected) => {
      if (!connected) {
        setFreighterInstalled(false);
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      // Restore identity so UI shows as connected; token will be fetched on first apiFetch call
      setPublicKey(savedKey);
      activeKeyRef.current = savedKey;
      setRole(savedRole);
    }).catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  // Watch for Freighter disconnect / account changes.
  // Prefer event listeners when available, and fall back to polling.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleAccountChange = (newKey) => {
      const current = activeKeyRef.current;
      if (!current) return; // not connected; nothing to invalidate
      if (newKey && newKey === current) return; // no change
      // Account changed or wallet disconnected: clear everything and force a fresh load
      clearWalletState();
    };

    const checkWallet = async () => {
      if (!activeKeyRef.current) return;
      try {
        const connected = await isConnected();
        if (!connected) {
          setFreighterInstalled(false);
          clearWalletState();
          return;
        }
        const pk = await getPublicKey();
        handleAccountChange(pk);
      } catch {
        // Transient errors (e.g. extension locked) should not wipe state
      }
    };

    const onFreighterEvent = (event) => {
      const detail = event && event.detail ? event.detail : {};
      const newKey = detail.publicKey || detail.address || null;
      if (detail.disconnected || !newKey) {
        if (activeKeyRef.current) clearWalletState();
        return;
      }
      handleAccountChange(newKey);
    };

    window.addEventListener('freighter:accountChanged', onFreighterEvent);
    window.addEventListener('freighter:disconnect', onFreighterEvent);
    const interval = setInterval(checkWallet, WALLET_POLL_INTERVAL);

    return () => {
      window.removeEventListener('freighter:accountChanged', onFreighterEvent);
      window.removeEventListener('freighter:disconnect', onFreighterEvent);
      clearInterval(interval);
    };
  }, [clearWalletState]);

  const apiFetch = useCallback(async (url, options = {}) => {
    // Create a fresh controller for this request so it can be aborted on
    // disconnect/account change.
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const doFetch = (t) => fetch(url, {
      ...options,
      signal,
      headers: { ...options.headers, Authorization: `Bearer ${t}` },
    });

    // If no token in memory yet, run SEP-10 to get one
    if (!tokenRef.current) {
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      tokenRef.current = data.token;
      activeKeyRef.current = pk;
      setRole(data.role);
    }

    let res = await doFetch(tokenRef.current);

    if (res.status === 401) {
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      tokenRef.current = data.token;
      activeKeyRef.current = pk;
      setRole(data.role);
      res = await doFetch(data.token);
    }

    return res;
  }, [runSep10]);

  const isConnectedState = !!publicKey;

  return (
    <AuthContext.Provider value={{
      publicKey,
      role,
      freighterInstalled,
      connect,
      disconnect,
      apiFetch,
      isConnected: isConnectedState,
      loading,
      error,
      // Increments on account change/disconnect so consumers can key data loads
      walletChangeCounter,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
