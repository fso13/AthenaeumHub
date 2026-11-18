import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ChatSummary } from '../api/types';
import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { CloseIcon, LockIcon } from './Icons';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Mirrors the server: trim, collapse internal runs of whitespace. */
function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Mirrors the server: CRLF -> LF, trim; empty clears to null. */
function normalizeDescription(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/** Server rule: control chars are rejected; description also allows LF/TAB. */
function hasDisallowedControl(value: string, allowed: ReadonlySet<number>): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !allowed.has(code)) return true;
  }
  return false;
}

const NAME_NO_CONTROL = new Set<number>();
const DESCRIPTION_CONTROL_ALLOWED = new Set<number>([0x09, 0x0a]);

function nameError(value: string): string | null {
  if (value.length === 0) return t('chatSettings.nameRequired');
  if (codePointLength(value) > NAME_MAX) return t('chatSettings.nameTooLong');
  if (value.includes('<') || value.includes('>') || hasDisallowedControl(value, NAME_NO_CONTROL)) {
    return t('chatSettings.nameInvalid');
  }
  return null;
}

function descriptionError(value: string): string | null {
  if (codePointLength(value) > DESCRIPTION_MAX) return t('chatSettings.descriptionTooLong');
  if (
    value.includes('<') ||
    value.includes('>') ||
    hasDisallowedControl(value, DESCRIPTION_CONTROL_ALLOWED)
  ) {
    return t('chatSettings.descriptionInvalid');
  }
  return null;
}

/**
 * D1-FE5 translated `PATCH /chats/{chatId}` failures. The server owns every
 * guard (workspace role, E2EE policy, validation); the UI only explains it.
 */
function chatSettingsErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatSettings.error.forbidden');
  if (error.status === 404) return t('chatSettings.error.notFound');
  if (error.status === 409) return t('chatSettings.error.conflict');
  if (error.status === 422) {
    if (error.code === 'CHAT_SETTINGS_E2EE_UNSUPPORTED') return t('chatSettings.error.e2ee');
    const field = error.details?.field;
    if (field === 'name') return t('chatSettings.error.name');
    if (field === 'description') return t('chatSettings.error.description');
    return t('chatSettings.error.validation');
  }
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatSettings.error.generic');
}

export interface ChatSettingsDialogProps {
  open: boolean;
  chat: ChatSummary | null;
  onClose: () => void;
  /** Opens the existing E12 workspace members dialog; no member API is duplicated. */
  onOpenMembers: () => void;
}

/**
 * D1-FE5 chat settings (D1-BE3 `PATCH /chats/{chatId}`).
 *
 * - OWNER/ADMIN edit name (1..120) and description (<=500); MEMBER/GUEST see
 *   the same values read-only (the server still enforces the role).
 * - E2EE: description is disabled with an honest explanation, name stays
 *   editable because the server explicitly allows the label.
 * - No optimistic update: the header/list change only after `200 Chat`; a
 *   successful save also re-reads the chat list.
 * - Members are delegated to the existing E12 dialog; danger actions are
 *   disabled until the backend exposes archive/leave/delete.
 * - Modal semantics: focus trap, Escape, focus return, labelled/described,
 *   loading/saving/error states and a 390 px-friendly layout.
 */
export function ChatSettingsDialog({
  open,
  chat,
  onClose,
  onOpenMembers,
}: ChatSettingsDialogProps) {
  const store = useChatStore();
  const state = useChatState();
  const settings = state.chatSettings;
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const leadId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();
  const descriptionErrorId = useId();
  const e2eeNoteId = useId();
  const readOnlyId = useId();
  const dangerNoteId = useId();

  const [name, setName] = useState(chat?.name ?? '');
  const [description, setDescription] = useState(chat?.description ?? '');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; description?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const initializedFor = useRef<string | null>(null);

  const role = state.activeWorkspace?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const isE2ee = (chat?.security_mode ?? 'MANAGED') === 'E2EE';
  const saving = settings.status === 'saving' && settings.chatId === chat?.id;
  const serverError = settings.status === 'error' ? settings.error : null;
  const serverField =
    serverError?.details?.field === 'name' || serverError?.details?.field === 'description'
      ? serverError.details.field
      : null;

  // Reset only when the dialog opens or switches to another chat; a live
  // summary refresh must not overwrite the draft.
  useEffect(() => {
    if (!open) {
      initializedFor.current = null;
      return;
    }
    const key = chat?.id ?? null;
    if (initializedFor.current === key) return;
    initializedFor.current = key;
    setName(chat?.name ?? '');
    setDescription(chat?.description ?? '');
    setFieldErrors({});
    setNotice(null);
    store.clearChatSettings();
  }, [open, chat, store]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
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
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open, saving]);

  if (!open || !chat) return null;

  const normalizedName = normalizeName(name);
  const normalizedDescription = normalizeDescription(description);
  const originalName = chat.name ?? '';
  const originalDescription = chat.description ?? '';
  const nameChanged = canManage && normalizedName !== originalName;
  const descriptionChanged = canManage && !isE2ee && normalizedDescription !== originalDescription;
  const dirty = nameChanged || descriptionChanged;

  const handleFieldChange = () => {
    if (notice) setNotice(null);
    if (settings.status !== 'idle') store.clearChatSettings();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || saving) return;
    setNotice(null);

    const nextErrors: { name?: string; description?: string } = {};
    const nextNameError = nameError(normalizedName);
    if (nextNameError) nextErrors.name = nextNameError;
    if (!isE2ee) {
      const nextDescriptionError = descriptionError(normalizedDescription);
      if (nextDescriptionError) nextErrors.description = nextDescriptionError;
    }
    setFieldErrors(nextErrors);
    if (nextErrors.name || nextErrors.description) return;

    if (!dirty) {
      setNotice(t('chatSettings.noChanges'));
      return;
    }

    const patch: { name?: string; description?: string } = {};
    if (nameChanged) patch.name = normalizedName;
    if (descriptionChanged) patch.description = normalizedDescription;

    const ok = await store.saveChatSettings(chat.id, patch);
    if (!ok) return;
    // Adopt the normalized values the server accepted; no optimistic state was
    // applied before the `200`.
    setName(normalizedName);
    setDescription(normalizedDescription);
    setFieldErrors({});
    setNotice(t('chatSettings.saved'));
  };

  const descriptionDisabled = !canManage || isE2ee;
  const descriptionValue = isE2ee ? '' : description;
  const nameServerInvalid = serverField === 'name';
  const descriptionServerInvalid = serverField === 'description';

  return (
    <div
      className="chat-settings-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="chat-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="chat-settings-dialog__head">
          <div>
            <h2 className="chat-settings-dialog__title" id={titleId}>
              {t('chatSettings.title')}
            </h2>
            <p className="chat-settings-dialog__lead" id={leadId}>
              {t('chatSettings.lead')}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label={t('chatSettings.close')}
            title={t('chatSettings.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        {!canManage ? (
          <p className="chat-settings-readonly" id={readOnlyId}>
            {t('chatSettings.readOnly')}
          </p>
        ) : null}

        {notice ? (
          <p className="chat-settings-notice" role="status">
            {notice}
          </p>
        ) : null}

        {serverError ? (
          <p className="chat-settings-error" role="alert">
            {chatSettingsErrorText(serverError)}
          </p>
        ) : null}

        <form
          className="chat-settings-form"
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
        >
          <section className="chat-settings-section" aria-labelledby={`${nameId}-section`}>
            <h3 className="chat-settings-section__title" id={`${nameId}-section`}>
              {t('chatSettings.main')}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor={nameId}>
                {t('chatSettings.name')}
              </label>
              <input
                ref={nameRef}
                id={nameId}
                className="field__input"
                type="text"
                value={name}
                autoComplete="off"
                disabled={!canManage || saving}
                aria-invalid={Boolean(fieldErrors.name) || nameServerInvalid}
                aria-describedby={[
                  nameHintId,
                  fieldErrors.name ? nameErrorId : null,
                  !canManage ? readOnlyId : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
                  handleFieldChange();
                }}
              />
              <div className="field__meta">
                <span id={nameHintId}>{t('chatSettings.nameHint')}</span>
                <span className="chat-settings-counter" aria-hidden="true">
                  {codePointLength(normalizedName)}/{NAME_MAX}
                </span>
              </div>
              {fieldErrors.name ? (
                <p className="field__error" id={nameErrorId} role="alert">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>
          </section>

          <section className="chat-settings-section" aria-labelledby={`${descriptionId}-section`}>
            <h3 className="chat-settings-section__title" id={`${descriptionId}-section`}>
              {t('chatSettings.description')}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor={descriptionId}>
                {t('chatSettings.description')}
              </label>
              <textarea
                id={descriptionId}
                className="field__input chat-settings-description"
                value={descriptionValue}
                rows={4}
                disabled={descriptionDisabled || saving}
                aria-invalid={Boolean(fieldErrors.description) || descriptionServerInvalid}
                aria-describedby={[
                  descriptionHintId,
                  fieldErrors.description ? descriptionErrorId : null,
                  isE2ee ? e2eeNoteId : null,
                  !canManage ? readOnlyId : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(event) => {
                  setDescription(event.target.value);
                  if (fieldErrors.description) {
                    setFieldErrors((prev) => ({ ...prev, description: undefined }));
                  }
                  handleFieldChange();
                }}
              />
              <div className="field__meta">
                <span id={descriptionHintId}>{t('chatSettings.descriptionHint')}</span>
                {!isE2ee ? (
                  <span className="chat-settings-counter" aria-hidden="true">
                    {codePointLength(normalizedDescription)}/{DESCRIPTION_MAX}
                  </span>
                ) : null}
              </div>
              {fieldErrors.description ? (
                <p className="field__error" id={descriptionErrorId} role="alert">
                  {fieldErrors.description}
                </p>
              ) : null}
            </div>
            {isE2ee ? (
              <div className="chat-settings-e2ee" id={e2eeNoteId}>
                <LockIcon aria-hidden="true" />
                <div>
                  <p className="chat-settings-e2ee__title">{t('chatSettings.e2eeTitle')}</p>
                  <p className="chat-settings-e2ee__text">{t('chatSettings.e2eeDescription')}</p>
                </div>
              </div>
            ) : null}
          </section>

          {canManage ? (
            <div className="chat-settings-form__actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={saving}
                aria-busy={saving}
              >
                {saving ? t('chatSettings.saving') : t('chatSettings.save')}
              </button>
            </div>
          ) : null}
        </form>

        <section className="chat-settings-section" aria-labelledby="chat-settings-members">
          <h3 className="chat-settings-section__title" id="chat-settings-members">
            {t('chatSettings.membersTitle')}
          </h3>
          <p className="chat-settings-section__hint">{t('chatSettings.membersLead')}</p>
          <button type="button" className="button button--secondary" onClick={onOpenMembers}>
            {t('chatSettings.membersOpen')}
          </button>
        </section>

        <section
          className="chat-settings-section chat-settings-danger"
          aria-labelledby="chat-settings-danger"
          aria-describedby={dangerNoteId}
        >
          <h3 className="chat-settings-section__title" id="chat-settings-danger">
            {t('chatSettings.dangerTitle')}
          </h3>
          <p className="chat-settings-section__hint">{t('chatSettings.dangerLead')}</p>
          <div className="chat-settings-danger__actions">
            <button type="button" className="button button--danger" disabled>
              {t('chatSettings.archive')}
            </button>
            <button type="button" className="button button--danger" disabled>
              {t('chatSettings.leave')}
            </button>
            <button type="button" className="button button--danger" disabled>
              {t('chatSettings.delete')}
            </button>
          </div>
          <p className="chat-settings-danger__note" id={dangerNoteId}>
            {t('chatSettings.dangerNote')}
          </p>
        </section>
      </div>
    </div>
  );
}
