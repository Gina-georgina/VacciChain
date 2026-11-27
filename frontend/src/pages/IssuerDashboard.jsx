import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';
import ConfirmMintDialog from '../components/ConfirmMintDialog';
import CopyButton from '../components/CopyButton';
import RoleBadge from '../components/RoleBadge';
import AsyncState from '../components/AsyncState';
import { pageContainerNarrow } from '../layout.js';

const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  input: { padding: '0.6rem 0.75rem', background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0', fontSize: '1rem', width: '100%', boxSizing: 'border-box' },
  inputError: { padding: '0.6rem 0.75rem', background: '#1e293b', border: '1px solid #f87171', borderRadius: 8, color: '#e2e8f0', fontSize: '1rem', width: '100%', boxSizing: 'border-box' },
  btn: { padding: '0.7rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', width: '100%', touchAction: 'manipulation' },
  btnDisabled: { padding: '0.7rem', background: '#334155', color: '#64748b', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'not-allowed', width: '100%' },
  label: { color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.25rem' },
  fieldError: { color: '#f87171', fontSize: '0.78rem', marginTop: '0.25rem' },
  statusBadge: { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.85rem', marginBottom: '1rem' },
  authorized: { background: '#065f46', color: '#10b981', border: '1px solid #10b981' },
  unauthorized: { background: '#7f1d1d', color: '#f87171', border: '1px solid #f87171' },
  warning: { background: '#78350f', color: '#f59e0b', padding: '0.75rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.9rem' },
};

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const today = () => new Date().toISOString().split('T')[0];
const FORM_KEY = 'issuer_form_draft';
const EMPTY_FORM = { patient_address: '', vaccine_name: '', date_administered: '' };

// Only non-sensitive fields are persisted. Patient-identifying data
// (patient_address) is intentionally excluded from the draft schema.
const DRAFT_FIELDS = ['vaccine_name', 'date_administered'];

const readDraft = () => {
  try {
    const saved = sessionStorage.getItem(FORM_KEY);
    if (!saved) return EMPTY_FORM;
    const parsed = JSON.parse(saved);
    const draft = { ...EMPTY_FORM };
    for (const key of DRAFT_FIELDS) {
      if (typeof parsed?.[key] === 'string') draft[key] = parsed[key];
    }
    return draft;
  } catch {
    return EMPTY_FORM;
  }
};

const writeDraft = (form) => {
  try {
    const draft = {};
    for (const key of DRAFT_FIELDS) draft[key] = form[key] ?? '';
    sessionStorage.setItem(FORM_KEY, JSON.stringify(draft));
  } catch {
    // Persistence is best-effort; ignore storage failures.
  }
};

const clearDraft = () => {
  try {
    sessionStorage.removeItem(FORM_KEY);
  } catch {
    // ignore storage failures
  }
};

export default function IssuerDashboard() {
  const { t } = useTranslation();
  const { publicKey, role, connect } = useAuth();
  const { issueVaccination, checkIssuerStatus, loading } = useVaccination();

  const [form, setForm] = useState(readDraft);
  const [touched, setTouched] = useState({});
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [mintResult, setMintResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(null);
  const [authStatus, setAuthStatus] = useState('idle');
  const [authError, setAuthError] = useState(null);

  const validate = (f) => {
    const errors = {};
    if (!STELLAR_ADDRESS_RE.test(f.patient_address))
      errors.patient_address = t('issuer.validation.invalidAddress');
    if (!f.vaccine_name.trim())
      errors.vaccine_name = t('issuer.validation.vaccineRequired');
    if (!f.date_administered)
      errors.date_administered = t('issuer.validation.dateRequired');
    else if (f.date_administered > today())
      errors.date_administered = t('issuer.validation.dateFuture');
    return errors;
  };

  const errors = validate(form);
  const isValid = Object.keys(errors).length === 0;

  useEffect(() => {
    writeDraft(form);
  }, [form]);

  const loadAuthorization = useCallback(async () => {
    setAuthStatus('loading');
    setAuthError(null);
    setIsAuthorized(null);
    try {
      const authorized = await checkIssuerStatus();
      setIsAuthorized(Boolean(authorized));
      setAuthStatus('success');
    } catch (err) {
      setIsAuthorized(null);
      setAuthError(err?.message || t('issuer.authCheckFailed', 'Unable to verify issuer authorization.'));
      setAuthStatus('error');
    }
  }, [checkIssuerStatus, t]);

  // Reset all wallet-scoped state whenever the active account changes or
  // disconnects, so the prior account's data is never shown.
  useEffect(() => {
    setForm(readDraft());
    setTouched({});
    setError(null);
    setSuccess(null);
    setMintResult(null);
    setConfirming(false);
    setIsAuthorized(null);
    setAuthError(null);
    setAuthStatus('idle');
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && role === 'issuer') {
      loadAuthorization();
    }
  }, [publicKey, role, loadAuthorization]);

  if (!publicKey) {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your issuer wallet.</p>
        <button style={styles.btn} onClick={connect} aria-label="Connect issuer wallet">Connect Wallet</button>
      </div>
    );
  }

  if (role !== 'issuer') {
    return <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}><p style={{ color: '#f87171' }}>{t('issuer.accessDenied')}</p></div>;
  }

  if (authStatus === 'loading' || authStatus === 'idle') {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <AsyncState status="loading" message="Checking authorization status..." />
      </div>
    );
  }

  if (authStatus === 'error') {
    return (
      <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
        <AsyncState
          status="error"
          message={authError || t('issuer.authCheckFailed', 'Unable to verify issuer authorization.')}
          onRetry={loadAuthorization}
        />
      </div>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const result = await issueVaccination(form);
    if (result) {
      setMintResult(result);
      setSuccess(true);
      // Successful issuance clears both in-memory fields and the persisted draft.
      setForm(EMPTY_FORM);
      setTouched({});
      clearDraft();
    } else {
      // Failed issuance preserves user-entered values and the draft.
      setError(t('issuer.issueFailed', 'Issuance failed. Your entries have been preserved.'));
    }
  };

  const fields = [
    { key: 'patient_address', label: t('issuer.patientAddress'), placeholder: 'G...', type: 'text' },
    { key: 'vaccine_name', label: t('issuer.vaccineName'), placeholder: t('issuer.vaccineNamePlaceholder'), type: 'text' },
    { key: 'date_administered', label: t('issuer.dateAdministered'), placeholder: '', type: 'date' },
  ];

  return (
    <div style={{ ...pageContainerNarrow, marginTop: '2rem', marginBottom: '2rem' }}>
      <div style={{ borderLeft: '4px solid #22c55e', paddingLeft: '0.75rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
          <h2 style={{ color: '#e2e8f0', margin: 0 }}>Issue Vaccination NFT</h2>
          <RoleBadge role="issuer" />
        </div>
      </div>
      <form style={styles.form} onSubmit={handleSubmit} role="form">
        {[
          { key: 'patient_address', label: 'Patient Stellar Address', placeholder: 'G...' },
          { key: 'vaccine_name', label: 'Vaccine Name', placeholder: 'e.g. COVID-19' },
          { key: 'date_administered', label: 'Date Administered', placeholder: 'YYYY-MM-DD' },
        ].map(({ key, label, placeholder }) => (
          <div key={key}>
            <label htmlFor={key} style={styles.label}>{label}</label>
            <input
              id={key}
              style={errors[key] ? styles.inputError : styles.input}
              placeholder={placeholder}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              required
            />
            {errors[key] && <p style={styles.fieldError}>{errors[key]}</p>}
          </div>
        ))}
        <button style={isAuthorized ? styles.btn : styles.btnDisabled} type="submit" disabled={loading || !isAuthorized} aria-disabled={loading || !isAuthorized}>
          {loading ? 'Minting…' : 'Issue Vaccination NFT'}
        </button>
      </form>
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#7f1d1d', borderRadius: 8, color: '#fecaca' }}>
            <p>{error}</p>
            <button
              type="button"
              style={{ ...styles.btn, marginTop: '0.5rem' }}
              onClick={handleSubmit}
              disabled={loading || !isAuthorized}
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}
        {mintResult && (
          <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#0f172a', borderRadius: 8, color: '#4ade80' }}>
            <p>✅ Vaccination NFT minted!</p>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.25rem', display: 'flex', alignItems: 'center' }}>
              Token ID: {mintResult.tokenId}
              <CopyButton text={String(mintResult.tokenId)} label="token ID" />
            </p>
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${mintResult.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.85rem', color: '#0ea5e9' }}
            >
              View on Stellar Explorer ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
