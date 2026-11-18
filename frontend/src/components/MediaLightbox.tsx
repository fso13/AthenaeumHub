import { useEffect, useId, useRef, type MouseEvent } from 'react';
import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { CloseIcon, DownloadIcon } from './Icons';

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface MediaLightboxProps {
  open: boolean;
  /** Presigned URL of a raster image; `null` never opens the dialog. */
  src: string | null;
  name: string;
  onClose: () => void;
  onDownload: () => void;
  /** The presigned image URL failed to load (expired/blocked link). */
  onImageError?: () => void;
  busy?: boolean;
  downloadError?: ApiError | null;
}

/**
 * Full-size image preview. It only ever receives raster presigned URLs
 * (`isSafePreviewImage`), so SVG/HTML can never become an `<img>` here.
 * Focus is trapped inside the dialog, Escape/backdrop close it, and focus
 * returns to the thumbnail that opened it.
 */
export function MediaLightbox({
  open,
  src,
  name,
  onClose,
  onDownload,
  onImageError,
  busy = false,
  downloadError = null,
}: MediaLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const hintId = useId();
  const visible = open && Boolean(src);

  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) =>
          !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
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
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [visible]);

  if (!visible || !src) return null;

  const described = downloadError ? describeError(downloadError) : null;
  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="media-lightbox" onClick={handleBackdrop} data-testid="media-lightbox">
      <div
        ref={dialogRef}
        className="media-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={-1}
      >
        <div className="media-lightbox__head">
          <h2 className="media-lightbox__title" id={titleId}>
            {t('attachments.previewTitle', { name })}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('attachments.closePreview')}
            title={t('attachments.closePreview')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <div className="media-lightbox__stage">
          <img
            className="media-lightbox__image"
            src={src}
            alt={t('attachments.imageAlt', { name })}
            referrerPolicy="no-referrer"
            onError={onImageError}
          />
        </div>

        {described ? (
          <p className="media-lightbox__error" role="alert">
            {described.message}
          </p>
        ) : null}

        <div className="media-lightbox__actions">
          <button
            type="button"
            className="button button--small"
            onClick={onDownload}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <DownloadIcon aria-hidden="true" />
            )}
            {busy ? t('attachments.loading') : t('attachments.download')}
          </button>
          <p className="media-lightbox__hint" id={hintId}>
            {t('attachments.lightboxHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
