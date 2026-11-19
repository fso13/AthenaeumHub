import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ChatSummary } from '../api/types';
import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { CloseIcon, CopyIcon, LinkIcon, LockIcon } from './Icons';
import { Avatar } from './Avatar';
import { roleLabel } from './pages/pageData';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

type TabId = 'main' | 'members' | 'rights' | 'privacy' | 'danger';

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

const COVER_BY_MODE = {
  managed: '/covers/cover-atlas.svg',
  e2ee: '/covers/cover-family.svg',
  direct: '/covers/cover-dm.svg',
} as const;

export interface ChatSettingsDialogProps {
  open: boolean;
  chat: ChatSummary | null;
  onClose: () => void;
  /** Opens the existing E12 workspace members dialog; no member API is duplicated. */
  onOpenMembers: () => void;
}

/**
 * D1 UX fidelity 2 chat settings.
 *
 * - 820 px / r18 / 58 px header + 42 px tabs (`Основное`, `Участники`, `Права`,
 *   `Опасная зона`; DIRECT: `Приватность`).
 * - Only `PATCH /chats/{chatId}` (name/description) is wired. Members delegate
 *   to the existing E12 directory; rights, invite links, cover upload, privacy
 *   toggles and danger actions stay honestly disabled until their APIs land.
 * - No optimistic update: the header/list change only after `200 Chat`.
 * - Focus trap, Escape, focus return, labelled/described, 390 px friendly.
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

  const [activeTab, setActiveTab] = useState<TabId>('main');
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
  const members = state.workspaceMembers.items;
  const membersState = state.workspaceMembers;

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
    setActiveTab('main');
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
    if (!open || activeTab !== 'members') return;
    if (membersState.status === 'idle') void store.loadWorkspaceMembers();
  }, [activeTab, membersState.status, open, store]);

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
    setName(normalizedName);
    setDescription(normalizedDescription);
    setFieldErrors({});
    setNotice(t('chatSettings.saved'));
  };

  const descriptionDisabled = !canManage || isE2ee;
  const descriptionValue = isE2ee ? '' : description;
  const nameServerInvalid = serverField === 'name';
  const descriptionServerInvalid = serverField === 'description';
  const isDirect = chat.type === 'DIRECT';
  const tabs: ReadonlyArray<{ id: TabId; label: string }> = isDirect
    ? [
        { id: 'main', label: t('chatSettings.tab.main') },
        { id: 'privacy', label: t('chatSettings.tab.privacy') },
        { id: 'danger', label: t('chatSettings.tab.danger') },
      ]
    : [
        { id: 'main', label: t('chatSettings.tab.main') },
        { id: 'members', label: t('chatSettings.tab.members') },
        { id: 'rights', label: t('chatSettings.tab.rights') },
        { id: 'danger', label: t('chatSettings.tab.danger') },
      ];
  const cover = isDirect
    ? COVER_BY_MODE.direct
    : isE2ee
      ? COVER_BY_MODE.e2ee
      : COVER_BY_MODE.managed;
  const typeLabel = isDirect ? t('chatSettings.type.direct') : t('chatSettings.type.group');
  const modeLabel = isE2ee ? t('chatSettings.mode.e2ee') : t('chatSettings.mode.managed');

  const membersPane = (
    <>
      <div className="form-row">
        <label htmlFor="chat-invite">{t('chatSettings.invite')}</label>
        <div className="invite-row">
          <input
            id="chat-invite"
            className="input"
            readOnly
            value={t('chatSettings.inviteShort')}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled
            title={t('chatSettings.inviteUnavailable')}
          >
            <CopyIcon aria-hidden="true" />
            {t('common.copy')}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="text">
          <b>{t('chatSettings.privInvites')}</b>
          <small>{t('chatSettings.privInvitesHint')}</small>
        </div>
        <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
      </div>
      {membersState.status === 'loading' && members.length === 0 ? (
        <p className="card-empty" role="status">
          {t('chatSettings.membersLoading')}
        </p>
      ) : null}
      {members.length === 0 && membersState.status !== 'loading' ? (
        <p className="card-empty">{t('chatSettings.membersEmpty')}</p>
      ) : null}
      {members.map((member) => (
        <div className="member-row" key={member.user_id}>
          <Avatar name={member.display_name} seed={member.user_id} size="xs" />
          <span className="name">
            {member.display_name}
            <small>{t(roleKey(member.role))}</small>
          </span>
          <span className={`role role--${member.role.toLowerCase()}`}>
            {roleLabel(member.role)}
          </span>
        </div>
      ))}
      <p className="pane-sub">{t('chatSettings.membersTabHint')}</p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onOpenMembers}>
          {t('chatSettings.openMembersTab')}
        </button>
      </div>
    </>
  );

  const mainPane = (
    <>
      <div className="chat-settings-head">
        <span className="chat-settings-cover">
          <img src={cover} alt="" />
        </span>
        <div>
          <div className="cs-name">{chat.name?.trim() || t('chatSettings.type.direct')}</div>
          <small>
            {members.length > 0
              ? t('chatSettings.coverMeta', { count: members.length, mode: modeLabel })
              : t('chatSettings.coverMetaLoading', { mode: modeLabel })}
          </small>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          disabled
          title={t('chatSettings.coverUnavailable')}
        >
          {t('chatSettings.editCover')}
        </button>
      </div>

      <form
        id="chat-settings-form"
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

        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="chat-type">{t('chatSettings.type')}</label>
            <select id="chat-type" className="select" disabled value={typeLabel}>
              <option>{typeLabel}</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="chat-mode">{t('chatSettings.mode')}</label>
            <input id="chat-mode" className="input" value={modeLabel} readOnly />
          </div>
        </div>

        {!isDirect ? (
          <div className="form-row">
            <label htmlFor="chat-invite-main">{t('chatSettings.invite')}</label>
            <div className="invite-row">
              <input
                id="chat-invite-main"
                className="input"
                readOnly
                value={t('chatSettings.inviteShort')}
              />
              <button type="button" className="btn btn--sm" disabled>
                <LinkIcon aria-hidden="true" />
                {t('common.copy')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onOpenMembers}>
            {t('chatSettings.openMembersTab')}
          </button>
        </div>
      </form>
    </>
  );

  return (
    <div
      className="modal-layer chat-settings-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal--lg chat-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {t('chatSettings.title')}
          </h2>
          <span className="modal-sub" id={leadId}>
            {chat.name?.trim() || t('chatSettings.type.direct')}
          </span>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            disabled={saving}
            aria-label={t('chatSettings.close')}
            title={t('chatSettings.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <div className="modal-tabs" role="tablist" aria-label={t('chatSettings.title')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`chat-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`chat-pane-${tab.id}`}
              className={`modal-tab${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.id === 'main') {
                  window.setTimeout(() => nameRef.current?.focus(), 0);
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
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

          <div
            role="tabpanel"
            id={`chat-pane-${activeTab}`}
            aria-labelledby={`chat-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'main' ? mainPane : null}

            {activeTab === 'members' ? membersPane : null}

            {activeTab === 'rights' ? (
              <>
                {[
                  ['chatSettings.rights.send', 'chatSettings.rights.sendHint'],
                  ['chatSettings.rights.invite', 'chatSettings.rights.inviteHint'],
                  ['chatSettings.rights.pin', 'chatSettings.rights.pinHint'],
                  ['chatSettings.rights.plugins', 'chatSettings.rights.pluginsHint'],
                  ['chatSettings.rights.export', 'chatSettings.rights.exportHint'],
                ].map(([title, hint]) => (
                  <div className="setting-row" key={title}>
                    <div className="text">
                      <b>{t(title as Parameters<typeof t>[0])}</b>
                      <small>{t(hint as Parameters<typeof t>[0])}</small>
                    </div>
                    <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
                  </div>
                ))}
                <p className="pane-sub">{t('chatSettings.rightsUnavailable')}</p>
              </>
            ) : null}

            {activeTab === 'privacy' ? (
              <>
                <div className="setting-row">
                  <div className="text">
                    <b>{t('chatSettings.privacy.secret')}</b>
                    <small>{t('chatSettings.privacy.secretHint')}</small>
                  </div>
                  <span className={`chip${isE2ee ? ' chip--accent' : ''}`}>
                    {isE2ee ? t('details.secretOn') : t('details.secretOff')}
                  </span>
                </div>
                {[
                  ['chatSettings.privacy.reads', 'chatSettings.privacy.readsHint'],
                  ['chatSettings.privacy.typing', 'chatSettings.privacy.typingHint'],
                  ['chatSettings.privacy.keys', 'chatSettings.privacy.keysHint'],
                ].map(([title, hint]) => (
                  <div className="setting-row" key={title}>
                    <div className="text">
                      <b>{t(title as Parameters<typeof t>[0])}</b>
                      <small>{t(hint as Parameters<typeof t>[0])}</small>
                    </div>
                    <span className="mode-chip mode-chip--mock">{t('common.unavailable')}</span>
                  </div>
                ))}
                <p className="pane-sub">{t('chatSettings.privacyUnavailable')}</p>
              </>
            ) : null}

            {activeTab === 'danger' ? (
              <div className="danger-cards">
                <div className="danger-card">
                  <h4>{t('chatSettings.archive')}</h4>
                  <p>{t('chatSettings.archiveHint')}</p>
                  <button type="button" className="btn btn--danger" disabled>
                    {t('chatSettings.archive')}
                  </button>
                </div>
                <div className="danger-card">
                  <h4>{isDirect ? t('chatSettings.blockContact') : t('chatSettings.leave')}</h4>
                  <p>{isDirect ? t('chatSettings.blockHint') : t('chatSettings.leaveHint')}</p>
                  <button type="button" className="btn btn--danger" disabled>
                    {isDirect ? t('chatSettings.blockContact') : t('chatSettings.leave')}
                  </button>
                </div>
                <div className="danger-card">
                  <h4>{t('chatSettings.delete')}</h4>
                  <p>{t('chatSettings.deleteHint')}</p>
                  <button type="button" className="btn btn--danger" disabled>
                    {t('chatSettings.delete')}
                  </button>
                </div>
                <p className="chat-settings-danger__note" id={dangerNoteId}>
                  {t('chatSettings.dangerNote')}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="modal-foot">
          {activeTab === 'danger' ? (
            <button type="button" className="btn" onClick={onClose}>
              {t('chatSettings.dangerClose')}
            </button>
          ) : activeTab === 'main' ? (
            canManage ? (
              <>
                <button type="button" className="btn" onClick={onClose} disabled={saving}>
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  form="chat-settings-form"
                  className="btn btn--accent"
                  disabled={saving}
                  aria-busy={saving}
                >
                  {saving ? t('chatSettings.saving') : t('chatSettings.save')}
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={onClose}>
                {t('chatSettings.dangerClose')}
              </button>
            )
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {t('chatSettings.dangerClose')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function roleKey(role: string): Parameters<typeof t>[0] {
  if (role === 'OWNER') return 'details.role.OWNER';
  if (role === 'ADMIN') return 'details.role.ADMIN';
  if (role === 'GUEST') return 'details.role.GUEST';
  return 'details.role.MEMBER';
}
