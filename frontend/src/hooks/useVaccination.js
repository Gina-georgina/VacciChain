import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useFreighter';
import { useToast } from './useToast';

// Module-level cache: walletAddress -> { records, timestamp }
export const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds

// Transaction lifecycle constants
const TX_POLL_INTERVAL = 2_000; // 2 seconds
const TX_POLL_TIMEOUT = 60_000; // 60 seconds
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;

// Safe, user-facing error categories (no provider internals)
export const TX_ERROR = {
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  REJECTED: 'rejected',
  SERVER: 'server',
  UNKNOWN: 'unknown',
};

const SUPPORT_PATH = {
  label: 'Contact support',
  url: 'mailto:support@example.com?subject=Transaction%20issue',
};

function isValidTxHash(hash) {
  return typeof hash === 'string' && TX_HASH_REGEX.test(hash);
}

function categorizeError(e) {
  if (!e) return TX_ERROR.UNKNOWN;
  if (e.name === 'AbortError') return TX_ERROR.TIMEOUT;
  if (e.name === 'TypeError' || /network|fetch/i.test(e.message || '')) return TX_ERROR.NETWORK;
  if (e.status && e.status >= 500) return TX_ERROR.SERVER;
  if (e.status && e.status >= 400) return TX_ERROR.REJECTED;
  return TX_ERROR.UNKNOWN;
}

function buildResult(status, extra = {}) {
  return {
    status,
    tokenId: extra.tokenId ?? null,
    transactionHash: extra.transactionHash ?? null,
    explorerUrl: extra.explorerUrl ?? null,
    error: extra.error ?? null,
    retry: extra.retry ?? null,
    support: SUPPORT_PATH,
  };
}

// Redaction utility for client-side diagnostics. Strips tokens, patient
// identifiers and record details before anything is logged or surfaced.
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|auth|jwt|key|wallet|address|patient|name|dob|birth|record|vaccin|issuer|hash)/i;
const TOKEN_LIKE_PATTERN = /\b(?:bearer\s+)?[A-Za-z0-9_-]{20,}\b/gi;

export function redactForDiagnostics(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    return input.replace(TOKEN_LIKE_PATTERN, '[REDACTED]');
  }
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redactForDiagnostics);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactForDiagnostics(value);
  }
  return out;
}

// Produce a safe, user-facing error message that never includes raw payloads.
function safeErrorMessage(e, fallback) {
  const raw = (e && typeof e.message === 'string' && e.message) || fallback;
  return redactForDiagnostics(raw);
}

export function useVaccination(walletAddress) {
  const { apiFetch } = useAuth();
  const toast = useToast();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  // Keep latest apiFetch/toast in refs so effects don't re-run when they change
  const apiFetchRef = useRef(apiFetch);
  const toastRef = useRef(toast);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const fetchFromApi = useCallback(async (wallet, signal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current(`/v1/vaccination/${wallet}`, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const list = Array.isArray(data.data) ? data.data : [];
      cache.set(wallet, { records: list, timestamp: Date.now() });
      setRecords(list);
      return list;
    } catch (e) {
      if (e.name === 'AbortError') return;
      const msg = safeErrorMessage(e, 'Failed to fetch records.');
      setError(msg);
      toastRef.current(msg, 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []); // stable — uses refs internally

  useEffect(() => {
    if (!walletAddress) return;

    const cached = cache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setRecords(cached.records);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    fetchFromApi(walletAddress, controller.signal);

    return () => { controller.abort(); };
  }, [walletAddress, fetchFromApi]);

  const refetch = useCallback(() => {
    if (!walletAddress) return;
    cache.delete(walletAddress);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return fetchFromApi(walletAddress, controller.signal);
  }, [walletAddress, fetchFromApi]);

  const pollTransaction = useCallback(async (txHash, signal) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < TX_POLL_TIMEOUT) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      let res;
      try {
        res = await apiFetchRef.current(`/v1/transaction/${txHash}/status`, { signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw Object.assign(new Error('network'), { name: 'TypeError', category: TX_ERROR.NETWORK });
      }
      if (res.ok) {
        const data = await res.json();
        const state = data && data.status;
        if (state === 'confirmed' || state === 'failed') {
          return { status: state, tokenId: data.tokenId ?? null };
        }
      } else if (res.status >= 400 && res.status < 500) {
        throw Object.assign(new Error('rejected'), { status: res.status, category: TX_ERROR.REJECTED });
      }
      await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL));
    }
    throw Object.assign(new Error('timeout'), { name: 'AbortError', category: TX_ERROR.TIMEOUT });
  }, []);

  const issueVaccination = useCallback(async (payload) => {
    setLoading(true);
    let txHash = null;
    try {
      const res = await apiFetchRef.current('/v1/vaccination/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw Object.assign(new Error('rejected'), { status: res.status, category: TX_ERROR.REJECTED });
      }
      txHash = isValidTxHash(data.transactionHash) ? data.transactionHash : null;
      if (!txHash) {
        // No valid identifier — cannot link to explorer, do not imply success.
        toastRef.current('Transaction submitted but no valid identifier was returned. Please retry.', 'error');
        return buildResult('failed', { error: TX_ERROR.UNKNOWN, retry: () => issueVaccination(payload) });
      }

      // Pending: identifier exists but not yet confirmed.
      toastRef.current('Transaction submitted. Waiting for confirmation…', 'info');

      const controller = new AbortController();
      abortRef.current = controller;
      let pollResult;
      try {
        pollResult = await pollTransaction(txHash, controller.signal);
      } catch (e) {
        const category = e.category || categorizeError(e);
        const status = category === TX_ERROR.TIMEOUT ? 'expired' : 'failed';
        const message =
          status === 'expired'
            ? 'Confirmation timed out. The transaction may still complete — check the explorer or retry.'
            : 'Could not confirm the transaction. Please retry or contact support.';
        toastRef.current(message, 'error');
        return buildResult(status, {
          transactionHash: txHash,
          explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
          error: category,
          retry: () => issueVaccination(payload),
        });
      }

      if (pollResult.status === 'confirmed') {
        const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
        toastRef.current(
          `Vaccination NFT minted! Token ID: ${pollResult.tokenId} — View on Explorer: ${explorerUrl}`,
          'success'
        );
        return buildResult('confirmed', {
          tokenId: pollResult.tokenId,
          transactionHash: txHash,
          explorerUrl,
        });
      }

      // On-chain failure
      toastRef.current('Transaction failed on-chain. Please retry or contact support.', 'error');
      return buildResult('failed', {
        transactionHash: txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
        error: TX_ERROR.REJECTED,
        retry: () => issueVaccination(payload),
      });
    } catch (e) {
      const category = categorizeError(e);
      toastRef.current(safeErrorMessage(e, 'Failed to issue vaccination. Please retry or contact support.'), 'error');
      return buildResult('failed', {
        transactionHash: txHash,
        error: category,
        retry: () => issueVaccination(payload),
      });
    } finally {
      setLoading(false);
    }
  }, [pollTransaction]);

  const checkIssuerStatus = useCallback(async () => {
    try {
      const res = await apiFetchRef.current('/v1/issuer/status');
      const data = await res.json();
      return res.ok ? data.authorized : false;
    } catch {
      return false;
    }
  }, []);

  return { records, loading, error, refetch, issueVaccination, checkIssuerStatus };
}
