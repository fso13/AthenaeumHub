import { useEffect, useId, useRef } from 'react';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { CloseIcon, LockIcon } from './Icons';

interface SafetyNumberDialogProps {
  open: boolean;
  chatId: string | null;
  onClose: () => void;
}

/**
 * E7-F5 basic verification entry: one safety number per peer device (§7.2).
 * The digits are computed locally from pinned keys; the dialog only displays
 * them and never sets `verified` by itself.
 */
export function SafetyNumberDialog({ open, chatId, onClose }: SafetyNumberDialogProps) {
  const state = useChatState();
  const store = useChatStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Trap focus inside the modal dialog (same rule as the other dialogs).
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose, open]);

  if (!open || chatId === null) return null;
  const chatState = state.e2ee.chats[chatId] ?? null;
  const devices = chatState?.devices ?? [];

  return (
    <div
      className="notification-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="notification-prefs e2ee-safety"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="notification-prefs__head">
          <LockIcon aria-hidden="true" />
          <h2 className="notification-prefs__title" id={titleId}>
            {t('e2ee.safetyTitle')}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('e2ee.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <p className="notification-prefs__lead">{t('e2ee.safetyIntro')}</p>

        {devices.length === 0 ? (
          <p className="notification-prefs__state">{t('e2ee.safetyEmpty')}</p>
        ) : (
          <ul className="e2ee-safety__list">
            {devices.map((device) => {
              const display = chatState?.safetyNumbers[device.deviceId] ?? '';
              const verificationHash = chatState?.verificationHashes[device.deviceId] ?? null;
              const keyChanged =
                chatState?.keyChanges.some((change) => change.deviceId === device.deviceId) ??
                false;
              const verifying = chatState?.verifyingDeviceId === device.deviceId;
              const statusLabel = keyChanged
                ? t('e2ee.safetyReverify')
                : device.verified
                  ? t('e2ee.safetyVerified')
                  : t('e2ee.safetyUnverified');
              return (
                <li className="e2ee-safety__item" key={device.deviceId}>
                  <div className="e2ee-safety__meta">
                    <span>
                      {device.isSelf
                        ? t('e2ee.safetyOwnDevice')
                        : t('e2ee.safetyDevice', { device: device.deviceId.slice(0, 8) })}
                    </span>
                    <span className="e2ee-safety__status">{statusLabel}</span>
                  </div>
                  <code className="e2ee-safety__code" aria-label={t('e2ee.safetyTitle')}>
                    {display || '—'}
                  </code>
                  {verificationHash !== null ? (
                    <code className="e2ee-safety__hash">
                      {t('e2ee.safetyHash', { hash: verificationHash })}
                    </code>
                  ) : null}
                  {device.verified && device.verifiedAt ? (
                    <span className="e2ee-safety__verified-at">
                      {t('e2ee.safetyVerifiedAt', {
                        date: new Date(device.verifiedAt).toISOString().slice(0, 10),
                      })}
                    </span>
                  ) : null}
                  {!device.isSelf && !device.verified && !keyChanged ? (
                    <button
                      type="button"
                      className="button button--small"
                      disabled={chatState?.verifyingDeviceId !== null}
                      onClick={() => {
                        void store.verifyE2eeDevice(chatId, device.deviceId, 'MANUAL');
                      }}
                    >
                      {verifying ? t('e2ee.safetyVerifying') : t('e2ee.safetyVerify')}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {chatState?.verificationError ? (
          <p className="notification-prefs__state" role="alert">
            {chatState.verificationError === 'KEY_CHANGE_DETECTED'
              ? t('e2ee.verifyKeyChanged')
              : t('e2ee.verifyFailed')}
          </p>
        ) : null}

        <div className="notification-prefs__actions">
          <button type="button" className="button" onClick={onClose}>
            {t('e2ee.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
