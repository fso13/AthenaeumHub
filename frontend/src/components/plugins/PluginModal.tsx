import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n/ru';
import { CloseIcon } from '../Icons';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface PluginModalProps {
  title: string;
  titleId: string;
  /** Optional description id for longer copy. */
  descriptionId?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

/**
 * Accessible modal shell for plugin actions: focus trap, Escape dismissal,
 * backdrop click, and focus return to the trigger. Rendered through a portal so
 * the fixed layer is not clipped by the chat/details stacking contexts.
 */
export function PluginModal({
  title,
  titleId,
  descriptionId,
  busy = false,
  onClose,
  children,
  footer,
}: PluginModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog ?? null;
    initial?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      if (!dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCloseRef.current();
      }}
    >
      <div
        className="modal modal--sm plugin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            disabled={busy}
            aria-label={t('pluginActions.close')}
            title={t('pluginActions.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}
