import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};
const box = {
  background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
  padding: '1.5rem', maxWidth: 420, width: '90%', color: '#e2e8f0',
};
const row = { display: 'flex', justifyContent: 'space-between', margin: '0.4rem 0', fontSize: '0.9rem' };
const btnRow = { display: 'flex', gap: '0.75rem', marginTop: '1.5rem' };
const btnConfirm = { flex: 1, padding: '0.7rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };
const btnCancel = { flex: 1, padding: '0.7rem', background: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };
const errorBox = { background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '0.75rem 1rem', marginTop: '1rem', color: '#fecaca', fontSize: '0.85rem' };
const errorTitle = { fontWeight: 600, marginBottom: '0.35rem', color: '#fca5a5' };
const errorAction = { marginTop: '0.5rem', color: '#fecaca', fontSize: '0.8rem' };

// Maps a wallet error category to safe, user-facing i18n keys. Raw provider
// error text is never rendered; only these curated messages are shown.
const WALLET_ERROR_KEYS = {
  rejected: 'wallet.errors.rejected',
  locked: 'wallet.errors.locked',
  provider_error: 'wallet.errors.providerError',
  missing_extension: 'wallet.errors.missingExtension',
};

function getFocusableElements(root) {
  if (!root) return [];
  const selectors = 'a[href],button:not([disabled]),textarea, input, select, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selectors)).filter((el) => el.offsetParent !== null);
}

export default function ConfirmMintDialog({ record, onConfirm, onCancel, walletError, submitting }) {
  const { t } = useTranslation();
  const overlayRef = useRef(null);
  const boxRef = useRef(null);
  const previousActive = useRef(null);

  useEffect(() => {
    previousActive.current = document.activeElement;
    const focusable = getFocusableElements(boxRef.current);
    (focusable[0] || boxRef.current)?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const nodes = getFocusableElements(boxRef.current);
        if (nodes.length === 0) {
          e.preventDefault();
          return;
        }
        const idx = nodes.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx === 0 || document.activeElement === boxRef.current) {
            nodes[nodes.length - 1].focus();
            e.preventDefault();
          }
        } else {
          if (idx === nodes.length - 1) {
            nodes[0].focus();
            e.preventDefault();
          }
        }
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousActive.current?.focus?.();
    };
  }, [onCancel]);

  return (
    <div ref={overlayRef} style={overlay} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.target === overlayRef.current && onCancel()}>
      <div style={box} ref={boxRef} tabIndex={-1}>
        <h3 id="dialog-title" style={{ marginBottom: '1rem', color: '#f1f5f9' }}>Confirm Vaccination Mint</h3>
        <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '1rem' }}>
          This action is irreversible. Please review the record before confirming.
        </p>
        <div style={{ background: '#0f172a', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <div style={row}><span style={{ color: '#64748b' }}>Patient</span><span style={{ wordBreak: 'break-all', maxWidth: '60%', textAlign: 'right' }}>{record.patient_address}</span></div>
          <div style={row}><span style={{ color: '#64748b' }}>Vaccine</span><span>{record.vaccine_name}</span></div>
          <div style={row}><span style={{ color: '#64748b' }}>Date</span><span>{record.date_administered}</span></div>
        </div>
        {walletError && (
          <div style={errorBox} role="alert" aria-live="assertive">
            <div style={errorTitle}>{t('wallet.errors.title')}</div>
            <div>{t(WALLET_ERROR_KEYS[walletError] || 'wallet.errors.providerError')}</div>
            <div style={errorAction}>{t('wallet.errors.retryHint')}</div>
          </div>
        )}
        <div style={btnRow}>
          <button style={btnCancel} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button style={btnConfirm} onClick={onConfirm} disabled={submitting}>
            {submitting ? t('wallet.errors.retrying') : (walletError ? t('wallet.errors.retry') : 'Confirm & Mint')}
          </button>
        </div>
      </div>
    </div>
  );
}
