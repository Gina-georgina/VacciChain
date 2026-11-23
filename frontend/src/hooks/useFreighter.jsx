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

// Sanitized, user-facing messages per error category. Never surface raw
// provider internals or secrets to the UI.
const WALLET_ERROR_MESSAGES = {
  missing_extension:
    'Freighter wallet not found. Install the Freighter browser extension, then reload this page and try again.',
  rejected:
    'Connection request was declined. Open Freighter and approve the request, then try again.',
  locked:
    'Your Freighter wallet is locked. Unlock Freighter with your password, then try again.',
  provider_error:
    'The wallet could not complete the request. Please try again, or reload the page if the problem persists.',
};

function makeWalletError(category) {
  return {
    category,
    message: WALLET_ERROR_MESSAGES[category] || WALLET_ERROR_MESSAGES.provider_error,
  };
}

// Map a raw Freighter/provider error into a typed, sanitized category.
function classifyWalletError(e) {
  const raw = String((e && (e.message || e.error || e)) || '').toLowerCase();

  if (
    raw.includes('not found') ||
    raw.includes('not installed') ||
    raw.includes('not available') ||
    raw.includes('no freighter') ||
    raw.includes('extension')
  ) {
    return makeWalletError('missing_extension');
  }
  if (
    raw.includes('reject') ||
    raw.includes('denied') ||
    raw.includes('declin') ||
    raw.includes('cancel') ||
    raw.includes('user refused') ||
    raw.includes('not allowed')
  ) {
    return makeWalletError('rejected');
  }
  if (raw.includes('lock') || raw.includes('unlock') || raw.includes('password')) {
    return makeWalletError('locked');
  }
  return makeWalletError('provider_error');
}

export function AuthProvider({ children }) {
  const toast = useToast();
  const [publicKey, setPublicKey] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [walletError, setWalletError] = useState(null);
  const [freighterInstalled, setFreighterInstalled] = useState(() => typeof window !== 'undefined' && !!window.freighter);
  // Token lives only in memory — never written to localStorage
  const tokenRef = useRef(null);

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
    setWalletError(null);
    try {
      let connected = false;
      try {
        connected = await isConnected();
      } catch {
        connected = false;
      }
      if (!connected || (typeof window !== 'undefined' && !window.freighter)) {
        setFreighterInstalled(false);
        const walletErr = makeWalletError('missing_extension');
        setWalletError(walletErr);
        setError(walletErr.message);
        toast(walletErr.message, 'error');
        throw new Error(walletErr.message);
      }
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      setPublicKey(pk);
      tokenRef.current = data.token;
      setRole(data.role);
      // Persist only publicKey and role — not the token
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ publicKey: pk, role: data.role }));
      toast('Wallet connected.', 'success');
      return data;
    } catch (e) {
      const walletErr = classifyWalletError(e);
      setWalletError(walletErr);
      setError(walletErr.message);
      toast(walletErr.message, 'error');
      throw new Error(walletErr.message);
    } finally {
      setLoading(false);
    }
  }, [runSep10, toast]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    tokenRef.current = null;
    setRole(null);
    setError(null);
    setWalletError(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

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
      setRole(savedRole);
    }).catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  const apiFetch = useCallback(async (url, options = {}) => {
    const doFetch = (t) => fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${t}` },
    });

    const refreshToken = async () => {
      const pk = await getPublicKey();
      const data = await runSep10(pk);
      tokenRef.current = data.token;
      setRole(data.role);
    };

    try {
      // If no token in memory yet, run SEP-10 to get one
      if (!tokenRef.current) {
        await refreshToken();
      }

      let res = await doFetch(tokenRef.current);

      if (res.status === 401) {
        await refreshToken();
        res = await doFetch(tokenRef.current);
      }

      return res;
    } catch (e) {
      const walletErr = classifyWalletError(e);
      setWalletError(walletErr);
      setError(walletErr.message);
      toast(walletErr.message, 'error');
      throw new Error(walletErr.message);
    }
  }, [runSep10, toast]);

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
      walletError,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
