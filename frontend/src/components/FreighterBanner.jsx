import { useState } from 'react';
import { useAuth } from '../hooks/useFreighter';

const INSTALL_URL = 'https://www.freighter.app/';

const ERROR_CONTENT = {
  missing_extension: {
    messageKey: 'wallet.errors.missingExtension',
    actionKey: 'wallet.errors.missingExtensionAction',
    action: 'install',
  },
  rejected: {
    messageKey: 'wallet.errors.rejected',
    actionKey: 'wallet.errors.rejectedAction',
    action: 'retry',
  },
  locked: {
    messageKey: 'wallet.errors.locked',
    actionKey: 'wallet.errors.lockedAction',
    action: 'unlock',
  },
  provider_error: {
    messageKey: 'wallet.errors.providerError',
    actionKey: 'wallet.errors.providerErrorAction',
    action: 'retry',
  },
};

function t(key, fallback) {
  return fallback;
}

export default function FreighterBanner() {
  const { freighterInstalled, walletError } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  const errorCategory = walletError && ERROR_CONTENT[walletError] ? walletError : null;
  const showMissingExtension = !freighterInstalled && !errorCategory;

  if (dismissed) return null;
  if (freighterInstalled && !errorCategory) return null;
  if (!freighterInstalled && !errorCategory && !showMissingExtension) return null;

  const content = errorCategory ? ERROR_CONTENT[errorCategory] : ERROR_CONTENT.missing_extension;

  const message = t(
    content.messageKey,
    errorCategory === 'rejected'
      ? 'Wallet connection was rejected.'
      : errorCategory === 'locked'
        ? 'Your Freighter wallet is locked.'
        : errorCategory === 'provider_error'
          ? 'The wallet provider returned an error.'
          : 'Freighter wallet not detected.'
  );

  const actionText = t(
    content.actionKey,
    content.action === 'install'
      ? 'Install Freighter'
      : content.action === 'unlock'
        ? 'Unlock your wallet in the Freighter extension, then try again.'
        : 'Approve the connection request in Freighter, then try again.'
  );

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        background: '#7c3aed', color: '#fff', padding: '0.6rem 1.5rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
      }}
    >
      <span>
        🦊 {message}{' '}
        {content.action === 'install' ? (
          <a href={INSTALL_URL} target="_blank" rel="noreferrer" style={{ color: '#e9d5ff', fontWeight: 600 }}>
            {actionText}
          </a>
        ) : (
          <span style={{ color: '#e9d5ff', fontWeight: 600 }}>{actionText}</span>
        )}
      </span>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('wallet.errors.dismiss', 'Dismiss')}
        style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}