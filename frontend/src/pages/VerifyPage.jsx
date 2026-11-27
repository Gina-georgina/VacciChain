import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import VerificationBadge from '../components/VerificationBadge';
import NFTCard from '../components/NFTCard';
import CopyButton from '../components/CopyButton';
import { useToast } from '../hooks/useToast';
import { pageContainerNarrow } from '../layout.js';

// Redact anything that looks like a token/secret and strip record details from
// messages before they reach the console, toasts, or error UI.
const SENSITIVE_PATTERN = /(bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|token[=:]\s*\S+|api[_-]?key[=:]\s*\S+/gi;

function sanitizeMessage(message) {
  const fallback = 'Verification failed. Please try again.';
  if (typeof message !== 'string' || !message.trim()) return fallback;
  const redacted = message.replace(SENSITIVE_PATTERN, '[redacted]');
  // Only surface short, generic messages; drop anything that may embed record data.
  return redacted.length > 200 ? fallback : redacted;
}

function deriveStatus(result) {
  if (!result) return 'not-found';
  if (result.revoked) return 'revoked';
  if (result.vaccinated) return 'verified';
  return 'not-found';
}

const styles = {
  input: { padding: '0.6rem 0.75rem', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: '1rem', width: '100%' },
  btn: { padding: '0.6rem 1.5rem', background: 'var(--btn-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', marginTop: '0.75rem' },
  urlBox: { marginTop: '1rem', padding: '0.75rem', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 8 },
  urlText: { margin: '0.5rem 0 0', color: 'var(--text)', fontSize: '0.9rem', wordBreak: 'break-all', userSelect: 'all', WebkitUserSelect: 'all', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' },
  retryBtn: { padding: '0.4rem 1rem', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.9rem', marginTop: '0.5rem', cursor: 'pointer' },
};

// Only surface messages we control; never leak raw provider/network internals.
const GENERIC_ERROR = 'Verification failed. Please try again.';

function safeErrorMessage(e) {
  const msg = e && typeof e.message === 'string' ? e.message : '';
  // Allow short, human-readable messages that don't look like stack traces or JSON blobs.
  if (msg && msg.length <= 200 && !/[{}\n]/.test(msg) && !/stack|internal|provider|rpc|fetch/i.test(msg)) {
    return msg;
  }
  return GENERIC_ERROR;
}

export default function VerifyPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [wallet, setWallet] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastAddress, setLastAddress] = useState('');

  const verify = async (address) => {
    const trimmed = address.trim();
    setLoading(true);
    setResult(null);
    setError(null);
    setLastAddress(trimmed);
    try {
      const res = await fetch(`/v1/verify/${encodeURIComponent(trimmed)}`);
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error((data && data.error) || GENERIC_ERROR);
      setResult(data);
    } catch (e) {
      const message = sanitizeMessage(safeErrorMessage(e));
      setError(message);
      toast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const w = params.get('wallet');
    if (w) {
      setWallet(w);
      verify(w);
    }
  }, []);

  const handleVerify = (e) => {
    e.preventDefault();
    const trimmed = wallet.trim();
    const url = new URL(window.location);
    url.searchParams.set('wallet', trimmed);
    window.history.pushState({}, '', url);
    verify(trimmed);
  };

  const handleRetry = () => {
    if (lastAddress) verify(lastAddress);
  };

  const verificationUrl = lastAddress
    ? `${window.location.origin}${window.location.pathname}?wallet=${encodeURIComponent(lastAddress)}`
    : '';

  return (
    <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
      <h2 style={{ marginBottom: '1.5rem', color: 'var(--text)' }}>Verify Vaccination Status</h2>
      <form onSubmit={handleVerify}>
        <label htmlFor="wallet-input" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          Stellar wallet address
        </label>
        <input
          id="wallet-input"
          style={styles.input}
          placeholder={t('verify.placeholder')}
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          aria-label="Stellar wallet address to verify"
          required
        />
        <button style={styles.btn} type="submit" disabled={loading} aria-disabled={loading}>
          {loading ? 'Checking…' : 'Verify'}
        </button>
      </form>

      <div aria-live="polite" aria-atomic="true">
        {error && (
          <div role="alert" style={{ marginTop: '1rem' }}>
            <p style={{ color: '#f87171', margin: 0 }}>Error: {error}</p>
            {lastAddress && (
              <button type="button" style={styles.retryBtn} onClick={handleRetry} disabled={loading}>
                Retry verification
              </button>
            )}
          </div>
        )}
      </div>

      {verificationUrl && (
        <section style={styles.urlBox} aria-labelledby="verify-url-heading">
          <h3 id="verify-url-heading" style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)' }}>
            Verification link (text alternative to QR code)
          </h3>
          <p style={{ margin: '0.25rem 0 0', color: '#64748b', fontSize: '0.85rem' }}>
            If you cannot scan a QR code, select or copy the link below and open it in your browser to verify this wallet.
          </p>
          <p style={styles.urlText}>
            <span>{verificationUrl}</span>
            <CopyButton text={verificationUrl} label="verification link" />
          </p>
        </section>
      )}

      {result && (
        <div style={{ marginTop: '1.5rem' }} aria-live="polite">
          <VerificationBadge
            status={deriveStatus(result)}
            vaccinated={result.vaccinated}
            recordCount={result.record_count}
          />
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: '1rem', wordBreak: 'break-all', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
            Wallet: {wallet}
            <CopyButton text={wallet} label="wallet address" />
          </p>
          <div style={{ marginTop: '1rem' }}>
            {result.records?.map((r) => <NFTCard key={r.token_id} record={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}
