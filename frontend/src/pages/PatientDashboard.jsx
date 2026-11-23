import { useState, useEffect } from 'react';
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
};

export default function PatientDashboard() {
  const { t } = useTranslation();
  const { publicKey, connect, disconnect } = useAuth();
  const { records, loading, error, refetch } = useVaccination(publicKey);
  const { consented, giveConsent, loading: consentLoading } = useConsent();
  const [qrRecord, setQrRecord] = useState(null);

  // Clear wallet-specific UI state whenever the active account changes or the
  // wallet disconnects, so the prior account's data is never shown.
  useEffect(() => {
    setQrRecord(null);
  }, [publicKey]);

  const handleDeclineConsent = () => {
    setQrRecord(null);
    disconnect();
  };

  const handleRetry = () => {
    // Retry only refetches data; safe form state (e.g. open QR modal) is kept.
    refetch();
  };

  // Treat a pending request as loading even if stale records exist, so a
  // stalled request is never mistaken for empty data.
  const isInitialLoading = loading && records.length === 0;
  const isRefreshing = loading && records.length > 0;
  const hasError = !loading && Boolean(error);
  const isEmpty = !loading && !error && records.length === 0;
  const isPartial = !loading && !error && records.length > 0;

  if (!publicKey) {
    return (
      <div style={styles.page}>
        <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>Connect your wallet to view records.</p>
        <button style={styles.btn} onClick={connect} aria-label="Connect Freighter wallet to view vaccination records">Connect Wallet</button>
      </div>
    );
  }

  if (consented === false) {
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

      {isInitialLoading && (
        <div role="status" aria-live="polite" aria-busy="true">
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Loading records…
          </span>
          <NFTCardSkeleton count={3} />
        </div>
      )}

      {hasError && (
        <div role="alert" style={{ textAlign: 'center', padding: '2rem 0' }}>
          <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>⚠️ {error}</p>
          <button style={styles.btn} onClick={handleRetry}>Retry</button>
        </div>
      )}

      {isEmpty && <EmptyState />}

      {isRefreshing && (
        <p role="status" aria-live="polite" style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          Refreshing records…
        </p>
      )}

      {isPartial && (
        <>
          {isRefreshing && <NFTCardSkeleton count={1} />}
          {records.map((r) => (
            <NFTCard
              key={r.token_id}
              record={r}
              onShowQR={setQrRecord}
            />
          ))}
        </>
      )}

      {qrRecord && (
        <QRCodeModal
          url={`${window.location.origin}/verify?wallet=${encodeURIComponent(publicKey)}&token=${encodeURIComponent(qrRecord.token_id)}`}
          onClose={() => setQrRecord(null)}
        />
      )}
    </div>
  );
}
