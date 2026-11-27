import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useFreighter';
import { useToast } from './useToast';

// Module-level cache: request URL -> { records, total, limit, timestamp }
export const cache = new Map();
const PAGE_SIZE = 10;
const recordsUrl = (wallet, page) => `/v1/vaccination/${wallet}?page=${page}&limit=${PAGE_SIZE}`;
const CACHE_TTL = 30_000; // 30 seconds

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
  const { apiFetch, walletAddress: activeAccount } = useAuth();
  const toast = useToast();
  const [records, setRecords] = useState([]);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, limit: PAGE_SIZE });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  // Track the account the current records belong to so we never show stale data
  const recordsAccountRef = useRef(null);
  // Keep latest apiFetch/toast in refs so effects don't re-run when they change
  const apiFetchRef = useRef(apiFetch);
  const toastRef = useRef(toast);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const fetchFromApi = useCallback(async (url, signal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current(url, { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const list = Array.isArray(data.data) ? data.data : [];
      if (signal.aborted) return;
      const meta = { total: data.total ?? list.length, limit: data.limit ?? PAGE_SIZE };
      cache.set(url, { records: list, ...meta, timestamp: Date.now() });
      setRecords(list);
      setPagination(meta);
      // The history may have shrunk since the last request
      setPage((p) => Math.min(p, Math.max(1, Math.ceil(meta.total / meta.limit))));
      return list;
    } catch (e) {
      if (e.name === 'AbortError') return;
      const msg = safeErrorMessage(e, 'Failed to fetch records.');
      setError(msg);
      toastRef.current(msg, 'error');
      return null;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []); // stable — uses refs internally

  useEffect(() => {
    setPage(1);
    setRecords([]);
    setPagination({ total: 0, limit: PAGE_SIZE });
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;

    const cached = cache.get(recordsUrl(walletAddress, page));
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setRecords(cached.records);
      setPagination({ total: cached.total, limit: cached.limit });
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    fetchFromApi(recordsUrl(walletAddress, page), controller.signal);

    return () => { controller.abort(); };
  }, [walletAddress, page, fetchFromApi]);

  const refetch = useCallback(() => {
    if (!walletAddress) return;
    for (const key of cache.keys()) {
      if (key.startsWith(`/v1/vaccination/${walletAddress}?`)) cache.delete(key);
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return fetchFromApi(recordsUrl(walletAddress, page), controller.signal);
  }, [walletAddress, page, fetchFromApi]);

  const issueVaccination = useCallback(async (payload) => {
    setLoading(true);
    try {
      const res = await apiFetchRef.current('/v1/vaccination/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${data.transactionHash}`;
      toastRef.current(`Vaccination NFT minted! View on Explorer: ${explorerUrl}`, 'success');
      return data;
    } catch (e) {
      toastRef.current(safeErrorMessage(e, 'Failed to issue vaccination.'), 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const checkIssuerStatus = useCallback(async () => {
    try {
      const res = await apiFetchRef.current('/v1/issuer/status');
      const data = await res.json();
      return res.ok ? data.authorized : false;
    } catch {
      return false;
    }
  }, []);

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  return { page, setPage, total: pagination.total, totalPages, records, loading, error, refetch, issueVaccination, checkIssuerStatus };
}
