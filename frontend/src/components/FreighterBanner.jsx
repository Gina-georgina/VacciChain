import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useFreighter';
import ExternalLink from './ExternalLink';

const INSTALL_URL = 'https://www.freighter.app/';

export default function FreighterBanner() {
  const { freighterInstalled, publicKey } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (typeof refreshWalletNetwork !== 'function') return;
    setRefreshing(true);
    try {
      await refreshWalletNetwork();
    } finally {
      setRefreshing(false);
    }
  };

  if (networkMismatch) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          background: '#b91c1c', color: '#fff', padding: '0.6rem 1.5rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '1rem', flexWrap: 'wrap',
        }}
      >
        <span>
          ⚠️ Network mismatch: this app is configured for{' '}
          <strong>{configuredNetwork || 'an unknown network'}</strong>, but your wallet is on{' '}
          <strong>{walletNetwork || 'an unknown network'}</strong>. Signing is blocked until the
          networks match. Switch networks in Freighter to match the app configuration, or update
          the app configuration to match your wallet, then retry.
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Retry wallet network detection"
          style={{
            background: '#fff', color: '#b91c1c', border: 'none', borderRadius: '4px',
            padding: '0.35rem 0.9rem', fontWeight: 600,
            cursor: refreshing ? 'wait' : 'pointer',
          }}
        >
          {refreshing ? 'Checking…' : 'Retry'}
        </button>
      </div>
    );
  }

  // Reset dismissal whenever the wallet connection state changes so stale
  // wallet UI is not shown after a disconnect or account switch.
  useEffect(() => {
    setDismissed(false);
  }, [freighterInstalled, publicKey]);

  if (freighterInstalled || dismissed) return null;

  return (
    <div style={{
      background: '#7c3aed', color: '#fff', padding: '0.6rem 1.5rem',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
    }}>
      <span>
        🦊 Freighter wallet not detected.{' '}
        <ExternalLink href={INSTALL_URL} style={{ color: '#e9d5ff', fontWeight: 600 }}>
          Install the Freighter wallet extension (opens in a new tab)
        </ExternalLink>{' '}
        to connect your wallet and issue or view records.
      </span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}