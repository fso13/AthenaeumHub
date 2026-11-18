import { t } from '../i18n/ru';
import type { RealtimeIssue } from '../store/chatStore';
import { AlertIcon, RefreshIcon, WifiOffIcon } from './Icons';

export function OfflineBanner() {
  return (
    <div className="banner banner--offline" role="status" aria-live="polite">
      <WifiOffIcon aria-hidden="true" />
      <span>{t('banner.offline')}</span>
    </div>
  );
}

export function RateLimitBanner({ seconds }: { seconds: number }) {
  if (seconds <= 0) return null;
  return (
    <div className="banner banner--warning" role="alert">
      <AlertIcon aria-hidden="true" />
      <span>{t('banner.rateLimit', { seconds })}</span>
    </div>
  );
}

export function SyncErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="banner banner--warning" role="status">
      <AlertIcon aria-hidden="true" />
      <span>{t('banner.syncError')}</span>
      <button type="button" className="button button--small" onClick={onRetry}>
        <RefreshIcon aria-hidden="true" />
        {t('common.retry')}
      </button>
    </div>
  );
}

interface RealtimeBannerProps {
  issue: RealtimeIssue | null;
  status: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'revoked';
  onReconnect: () => void;
}

/**
 * Connection failures never block REST send/history. Auth/forbidden/protocol
 * failures are alerts; transient reconnect attempts are a polite status.
 */
export function RealtimeBanner({ issue, status, onReconnect }: RealtimeBannerProps) {
  if (!issue && status !== 'reconnecting') return null;
  if (status === 'online' || status === 'idle') return null;

  const kind = issue?.kind ?? 'network';
  const alert = kind !== 'network';
  const message =
    kind === 'forbidden'
      ? t('banner.realtimeForbidden')
      : kind === 'auth'
        ? t('banner.realtimeAuth')
        : kind === 'budget'
          ? t('banner.realtimeBudget')
          : kind === 'protocol'
            ? t('banner.realtimeProtocol')
            : kind === 'revoked'
              ? t('banner.realtimeRevoked')
              : t('banner.realtimeReconnecting');

  return (
    <div
      className={`banner banner--${kind === 'forbidden' ? 'danger' : 'warning'}`}
      role={alert ? 'alert' : 'status'}
      aria-live={alert ? undefined : 'polite'}
    >
      <AlertIcon aria-hidden="true" />
      <span>{message}</span>
      {kind === 'network' || kind === 'budget' ? (
        <button type="button" className="button button--small" onClick={onReconnect}>
          <RefreshIcon aria-hidden="true" />
          {t('banner.realtimeReconnect')}
        </button>
      ) : null}
      {kind === 'auth' || kind === 'revoked' || kind === 'protocol' ? (
        <button
          type="button"
          className="button button--small"
          onClick={() => window.location.reload()}
        >
          {t('common.reload')}
        </button>
      ) : null}
    </div>
  );
}
