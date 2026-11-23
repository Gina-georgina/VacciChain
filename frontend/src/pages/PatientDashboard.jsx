import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';
import { useConsent } from '../hooks/useConsent';
import NFTCard from '../components/NFTCard';
import RoleBadge from '../components/RoleBadge';
import NFTCardSkeleton from '../components/NFTCardSkeleton';
import EmptyState from '../components/EmptyState';
import RecordDetailModal from '../components/RecordDetailModal';
import CopyButton from '../components/CopyButton';
import QRCodeModal from '../components/QRCodeModal';
import ConsentScreen from '../components/ConsentScreen';

const styles = {
  page: { maxWidth: 700, width: '100%', margin: '2rem auto', padding: '0 1rem', boxSizing: 'border-box' },
  header: { borderLeft: '4px solid #0ea5e9', paddingLeft: '0.75rem', marginBottom: '1.5rem' },
  btn: { padding: '0.6rem 1.5rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  secondaryBtn: { padding: '0.5rem 1.1rem', background: 'transparent', color: '#0ea5e9', border: '1px solid #0ea5e9', borderRadius: 8, cursor: 'pointer' },
  privacySection: { border: '1px solid #1e293b', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1.5rem', background: '#0f172a' },
  privacyHeader: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' },
  privacyTitle: { color: '#e2e8f0', margin: 0, fontSize: '1.05rem' },
  statusRow: { color: '#94a3b8', fontSize: '0.9rem', margin: '0.25rem 0' },
  statusValue: { color: '#e2e8f0', fontWeight: 600 },
  scopeList: { margin: '0.25rem 0 0', paddingLeft: '1.25rem', color: '#94a3b8', fontSize: '0.9rem' },
  confirmation: { color: '#4ade80', fontSize: '0.9rem', marginTop: '0.5rem' },
};

export default function PatientDashboard() {
  const { t } = useTranslation();
  const { publicKey, connect, disconnect } = useAuth();
  const { records, loading, error, refetch } = useVaccination(publicKey);
  const {
    consented,
    scope,
    giveConsent,
    revokeConsent,
    refreshConsent,
    loading: consentLoading,
  } = useConsent();
  const [qrRecord, setQrRecord] = useState(null);
  const [showConsentSettings, setShowConsentSettings] = useState(false);
  const [consentConfirmation, setConsentConfirmation] = useState(null);

  const handleDeclineConsent = () => disconnect();

  const handleConsentUpdate = async (nextConsent) => {
    try {
      if (nextConsent === false) {
        await revokeConsent();
        setConsentConfirmation(t('consent.revokedConfirmation', 'Your consent has been revoked. Records are no longer shared.'));
      } else {
        await giveConsent(nextConsent);
        setConsentConfirmation(t('consent.updatedConfirmation', 'Your consent settings have been updated.'));
      }
    } finally {
      // Always re-render from the authoritative API state.
      if (refreshConsent) await refreshConsent();
      setShowConsentSettings(false);
    }
  };

  if (!publicKey) {
    return (
      <div style={styles.page}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your wallet to view records.</p>
        <button style={styles.btn} onClick={connect} aria-label="Connect Freighter wallet to view vaccination records">Connect Wallet</button>
      </div>
    );
  }

  if (consented === false && !showConsentSettings) {
    return (
      <div style={styles.page}>
        <ConsentScreen
          onAccept={giveConsent}
          onDecline={handleDeclineConsent}
          loading={consentLoading}
        />
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
          <h2 style={{ color: '#e2e8f0', margin: 0 }}>{t('patient.title')}</h2>
          <RoleBadge role="patient" />
        </div>
        {records.length > 0 && (
          <span style={{ color: '#64748b', fontSize: '0.85rem' }}>
            {records.length} records
          </span>
        )}
      </div>
      <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1.5rem', wordBreak: 'break-all' }}>
        Wallet: {publicKey}
        <CopyButton text={publicKey} label="wallet address" />
      </p>

      <section style={styles.privacySection} aria-labelledby="privacy-consent-heading">
        <div style={styles.privacyHeader}>
          <h3 id="privacy-consent-heading" style={styles.privacyTitle}>
            {t('consent.privacyHeading', 'Privacy & Consent')}
          </h3>
          <button
            type="button"
            style={styles.secondaryBtn}
            onClick={() => {
              setConsentConfirmation(null);
              setShowConsentSettings((v) => !v);
            }}
            aria-expanded={showConsentSettings}
            aria-controls="privacy-consent-panel"
          >
            {showConsentSettings
              ? t('consent.closeSettings', 'Close settings')
              : t('consent.manageSettings', 'Manage consent settings')}
          </button>
        </div>
        <p style={styles.statusRow}>
          {t('consent.currentStatus', 'Current status')}:{' '}
          <span style={styles.statusValue}>
            {consented
              ? t('consent.statusGranted', 'Consent granted')
              : t('consent.statusNotGranted', 'Consent not granted')}
          </span>
        </p>
        {consented && scope && (
          <div style={styles.statusRow}>
            {t('consent.currentScope', 'Shared scope')}:
            {Array.isArray(scope) ? (
              <ul style={styles.scopeList}>
                {scope.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <span style={styles.statusValue}> {String(scope)}</span>
            )}
          </div>
        )}
        {consentConfirmation && (
          <p style={styles.confirmation} role="status" aria-live="polite">
            {consentConfirmation}
          </p>
        )}
        {showConsentSettings && (
          <div id="privacy-consent-panel" style={{ marginTop: '1rem' }}>
            <ConsentScreen
              mode="update"
              initialConsent={consented}
              initialScope={scope}
              onAccept={handleConsentUpdate}
              onDecline={() => handleConsentUpdate(false)}
              loading={consentLoading}
            />
          </div>
        )}
      </section>

      {loading && <NFTCardSkeleton count={3} />}
      {!loading && error && (
        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
          <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>⚠️ {error}</p>
          <button style={styles.btn} onClick={refetch}>Retry</button>
        </div>
      )}
      {!loading && !error && records.length === 0 && <EmptyState />}

      {records.map((r) => (
        <NFTCard
          key={r.token_id}
          record={r}
          onShowQR={setQrRecord}
        />
      ))}

      {qrRecord && (
        <QRCodeModal
          url={`${window.location.origin}/verify?wallet=${encodeURIComponent(publicKey)}&token=${encodeURIComponent(qrRecord.token_id)}`}
          onClose={() => setQrRecord(null)}
        />
      )}
    </div>
  );
}
