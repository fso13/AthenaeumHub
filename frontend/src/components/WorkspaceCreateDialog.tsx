import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/ru';
import { CloseIcon } from './Icons';

interface WorkspaceCreateDialogProps {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

/** Small create-workspace dialog used by the rail "+" and the switcher. */
export function WorkspaceCreateDialog({
  open,
  busy,
  error,
  onClose,
  onCreate,
}: WorkspaceCreateDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) {
      setName('');
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', handle);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handle);
    };
  }, [busy, onClose, open]);

  if (!open) return null;
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <h2 id={titleId}>{t('workspace.create.title')}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('common.close')}
            onClick={onClose}
            disabled={busy}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <p className="pane-sub">{t('workspace.create.lead')}</p>
          <label className="field__label" htmlFor="workspace-create-name">
            {t('workspace.create.name')}
          </label>
          <input
            id="workspace-create-name"
            ref={inputRef}
            className="input"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('workspace.create.placeholder')}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <p className="field__error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--accent"
            disabled={!valid || busy}
            onClick={() => void onCreate(trimmed)}
          >
            {busy ? t('workspace.create.creating') : t('workspace.create.submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
