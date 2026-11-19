import type { AppState } from '../store/chatStore';
import { t } from '../i18n/ru';
import { AlertIcon, LockIcon, RefreshIcon } from './Icons';

interface E2eeBannerProps {
  state: AppState;
  chatId: string;
  onAcceptKeyChange: (userId: string, deviceId: string) => void;
  onConfirmManaged: () => void;
  onRefresh: () => void;
  onRetryReset: () => void;
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

/**
 * E7-F5: every blocking/unavailable E2EE state is rendered here, above the
 * message list. A blocking banner never offers a "send as plaintext" action:
 * the only exits are accepting the new key, confirming a genuinely managed
 * chat, or retrying the E2EE state.
 */
export function E2eeBanner({
  state,
  chatId,
  onAcceptKeyChange,
  onConfirmManaged,
  onRefresh,
  onRetryReset,
}: E2eeBannerProps) {
  const chat = state.chats.find((item) => item.id === chatId) ?? null;
  const e2ee = state.e2ee;
  const chatState = e2ee.chats[chatId] ?? null;
  const progress = chatState?.resetProgress ?? null;
  const uncovered = chatState?.unavailableDeviceIds ?? [];
  // Reset/retry progress is independent of the blocking banners below; keep it
  // visible even when a plaintext alert or a transient error is also shown.
  const progressBanners = (
    <>
      {progress?.status === 'running' ? (
        <div className="banner banner--warning" role="status" aria-live="polite">
          <RefreshIcon aria-hidden="true" />
          <span>{t('e2ee.resetRunning', { done: progress.done, total: progress.total })}</span>
        </div>
      ) : null}
      {progress?.status === 'failed' ? (
        <div className="banner banner--warning" role="alert">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.resetFailed', { count: progress.remaining + progress.failed })}</span>
          <button type="button" className="button button--small" onClick={onRetryReset}>
            <RefreshIcon aria-hidden="true" />
            {t('e2ee.retryReset')}
          </button>
        </div>
      ) : null}
      {progress?.status === 'completed' ? (
        <div className="banner banner--status" role="status" aria-live="polite">
          <LockIcon aria-hidden="true" />
          <span>{t('e2ee.resetCompleted')}</span>
        </div>
      ) : null}
      {progress === null && chatState?.retryPendingCount ? (
        <div className="banner banner--warning" role="status">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.retryPending', { count: chatState.retryPendingCount })}</span>
          <button type="button" className="button button--small" onClick={onRetryReset}>
            <RefreshIcon aria-hidden="true" />
            {t('e2ee.retryReset')}
          </button>
        </div>
      ) : null}
    </>
  );
  const coverageBanners = (
    <>
      {chatState?.coverageWarning === 'PEER_DEVICE_UNCOVERED' ? (
        <div className="banner banner--warning" role="status">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.coveragePeer')}</span>
          {uncovered.length > 0 ? (
            <ul className="e2ee-banner__devices">
              {uncovered.map((deviceId) => (
                <li key={deviceId}>{t('e2ee.coverageDevice', { device: shortId(deviceId) })}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {chatState?.coverageWarning === 'SELF_DEVICE_UNCOVERED' ? (
        <div className="banner banner--warning" role="status">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.coverageSelf')}</span>
        </div>
      ) : null}
    </>
  );

  if (!e2ee.enabled) {
    if (chat?.security_mode !== 'E2EE') return null;
    return (
      <div className="banner banner--danger" role="alert">
        <LockIcon aria-hidden="true" />
        <span>{t('e2ee.flagDisabled')}</span>
      </div>
    );
  }

  if (e2ee.browserUnsupported) {
    // ADR-26 runtime floor: the browser failed the RFC 8032 Ed25519 probe.
    // There is no "retry" that can fix the engine and no plaintext fallback.
    return (
      <div className="banner banner--danger" role="alert">
        <AlertIcon aria-hidden="true" />
        <span>{t('e2ee.unsupportedBrowser')}</span>
      </div>
    );
  }

  if (e2ee.status === 'error') {
    return (
      <div className="banner banner--danger" role="alert">
        <AlertIcon aria-hidden="true" />
        <span>{t('e2ee.decryptError')}</span>
        <button type="button" className="button button--small" onClick={onRefresh}>
          <RefreshIcon aria-hidden="true" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (chatState?.keyChanges.length) {
    return (
      <div className="e2ee-banner banner--danger" role="alert">
        <div className="e2ee-banner__head">
          <AlertIcon aria-hidden="true" />
          <strong>{t('e2ee.keyChangeTitle')}</strong>
        </div>
        <p>{t('e2ee.keyChangeText')}</p>
        <ul className="e2ee-banner__devices">
          {chatState.keyChanges.map((change) => (
            <li key={change.deviceId}>
              <span>{t('e2ee.keyChangeDevice', { device: shortId(change.deviceId) })}</span>
              <button
                type="button"
                className="button button--small"
                onClick={() => onAcceptKeyChange(change.userId, change.deviceId)}
              >
                {t('e2ee.acceptKey')}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (chatState?.modeAction === 'block_security_alert') {
    return (
      <div className="e2ee-banner banner--danger" role="alert">
        <div className="e2ee-banner__head">
          <AlertIcon aria-hidden="true" />
          <strong>{t('e2ee.modeAlertTitle')}</strong>
        </div>
        <p>{t('e2ee.modeAlertText')}</p>
        <button type="button" className="button button--small" onClick={onRefresh}>
          <RefreshIcon aria-hidden="true" />
          {t('e2ee.refresh')}
        </button>
      </div>
    );
  }

  if (chatState?.modeAction === 'confirm_mode_required') {
    return (
      <div className="banner banner--warning" role="status">
        <AlertIcon aria-hidden="true" />
        <span>
          <strong>{t('e2ee.modeConfirmTitle')}</strong> {t('e2ee.modeConfirmText')}
        </span>
        <button type="button" className="button button--small" onClick={onConfirmManaged}>
          {t('e2ee.confirmManaged')}
        </button>
      </div>
    );
  }

  if (chatState?.plaintextAlert) {
    return (
      <>
        {progressBanners}
        {coverageBanners}
        <div className="banner banner--danger" role="alert">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.plaintextAlert')}</span>
        </div>
      </>
    );
  }

  if (chatState?.error && chatState.error !== 'unsupported') {
    return (
      <>
        {progressBanners}
        {coverageBanners}
        <div className="banner banner--warning" role="status">
          <AlertIcon aria-hidden="true" />
          <span>{t('e2ee.decryptError')}</span>
          <button type="button" className="button button--small" onClick={onRefresh}>
            <RefreshIcon aria-hidden="true" />
            {t('common.retry')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {progressBanners}
      {coverageBanners}
    </>
  );
}
