import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ApiError } from '../../api/problem';
import { t } from '../../i18n/ru';
import { ErrorDetails } from '../ErrorDetails';
import { CloseIcon } from '../Icons';
import type { AdminActionErrorInfo } from './actionErrors';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AdminConfirmDialogProps {
  title: string;
  /** Consequence text; rendered inside the described-by node. */
  description: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  cancelLabel?: string;
  /** `true` while a required typed confirmation is still incomplete. */
  confirmDisabled?: boolean;
  /** Destructive confirm styling (danger button). */
  destructive?: boolean;
  busy: boolean;
  /** Translated failure copy; the dialog stays open for retryable errors. */
  error: AdminActionErrorInfo | null;
  /** Raw code/request id disclosure for non-retryable diagnostics. */
  errorDetails?: ApiError | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * E11-F confirmation dialog (FR-ADM-18).
 *
 * Every destructive/irreversible admin action asks for an explicit confirm:
 * * modal semantics (`role=dialog`, `aria-modal`, labelled + described);
 * * focus moves to the safe action (Cancel) and returns to the trigger on close;
 * * Tab is trapped, Escape and backdrop close it unless a request is in flight;
 * * the dialog remains open on retryable failures, so a user can retry without
 *   losing the context; `busy` disables both actions to prevent double submits.
 */
export function AdminConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  cancelLabel,
  destructive = false,
  confirmDisabled = false,
  busy,
  error,
  errorDetails = null,
  onConfirm,
  onClose,
}: AdminConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Mount-only: focus/return, scroll lock and the key listener read `busy` from
  // a ref so a pending request does not reset the focus position.
  useEffect(() => {
    const trigger = document.activeElement;
    // Safe default: Cancel, never the destructive action.
    cancelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) =>
          !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
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
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <div
      className="notification-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="notification-prefs admin-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="notification-prefs__head">
          <h2 className="notification-prefs__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('admin.actions.close')}
            title={t('admin.actions.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <div className="admin-confirm__body" id={descriptionId}>
          {description}
        </div>

        {error ? (
          <p className={`admin-confirm__notice admin-confirm__notice--${error.tone}`} role="alert">
            {error.text}
          </p>
        ) : null}

        {error && error.tone === 'error' && errorDetails ? (
          <ErrorDetails error={errorDetails} />
        ) : null}

        <div className="notification-prefs__actions admin-confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel ?? t('admin.actions.cancel')}
          </button>
          <button
            type="button"
            className={destructive ? 'button button--danger' : 'button button--primary'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            aria-busy={busy}
          >
            {busy ? busyLabel : error?.retryable ? t('admin.actions.retry') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
