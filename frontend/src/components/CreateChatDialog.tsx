import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { WorkspaceMemberRole } from '../api/types';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { t } from '../i18n/ru';
import { newUuid } from '../lib/ids';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { CloseIcon } from './Icons';

const MAX_NAME_LENGTH = 120;
const MAX_MEMBER_QUERY_LENGTH = 80;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

type ChatType = 'GROUP' | 'DIRECT';

function numberFromDetails(
  details: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = details?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function limitMessage(details: Record<string, unknown> | undefined): string {
  const scope = details?.scope;
  const limit = numberFromDetails(details, 'limit');
  const used = numberFromDetails(details, 'used');
  if (limit !== null && used !== null) {
    return t(
      scope === 'WORKSPACE' ? 'chat.create.limitReachedWorkspace' : 'chat.create.limitReached',
      {
        used,
        limit,
      },
    );
  }
  return t('chat.create.limitReachedGeneric');
}

function memberRoleLabel(role: WorkspaceMemberRole): string {
  switch (role) {
    case 'OWNER':
      return t('chat.create.roleOwner');
    case 'ADMIN':
      return t('chat.create.roleAdmin');
    case 'GUEST':
      return t('chat.create.roleGuest');
    default:
      return t('chat.create.roleMember');
  }
}

/**
 * R-01/UC-23/E10-F: GROUP and DIRECT chat creation.
 *
 * GROUP needs a 1..120 name and an OWNER/ADMIN role. DIRECT needs exactly one
 * `peer_id` from the active member directory; the caller is filtered out and
 * the payload never contains a name or invented member fields. The idempotency
 * key is created fresh when the dialog opens and reused only for an identical
 * logical payload, so a retry after an ambiguous failure replays one creation.
 */
export function CreateChatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useChatStore();
  const state = useChatState();
  const [type, setType] = useState<ChatType>('GROUP');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const debouncedMemberQuery = useDebouncedValue(memberQuery, 300);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const memberSearchRef = useRef<HTMLInputElement>(null);
  const memberListRef = useRef<HTMLFieldSetElement>(null);
  const requestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const titleId = useId();
  const hintId = useId();
  const groupHintId = useId();
  const directHintId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const memberSearchId = useId();
  const memberSearchHintId = useId();
  const memberCountId = useId();

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;
  const showValidation = touched && type === 'GROUP' && !nameValid;
  const role = state.activeWorkspace?.role ?? null;
  // Dev mode has no workspace projection; password mode uses the server role.
  const groupAllowed = role === null || role === 'OWNER' || role === 'ADMIN';
  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const members = state.workspaceMembers.items.filter((member) => member.user_id !== viewerId);
  const memberStatus = state.workspaceMembers.status;
  const memberQueryActive = memberQuery.trim().length > 0;
  const showMemberSkeleton = memberStatus === 'loading' && members.length === 0;
  const showMemberError = memberStatus === 'error' && members.length === 0;
  const showMemberEmpty = memberStatus === 'ready' && members.length === 0;
  const showMemberStaleError = memberStatus === 'error' && members.length > 0;

  const limits = state.chatLimits;
  const used = limits?.chats_used ?? null;
  const max = limits?.max_chats_per_user ?? null;
  const limitReached = used !== null && max !== null && used >= max;
  const creating = state.chatCreateStatus === 'creating';
  const groupReady = type === 'GROUP' && nameValid && groupAllowed;
  const directReady = type === 'DIRECT' && peerId !== null;
  const canSubmit = (groupReady || directReady) && !limitReached && !creating;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setName('');
    setTouched(false);
    setPeerId(null);
    setMemberQuery('');
    // GROUP requires OWNER/ADMIN; a member opens directly on DIRECT.
    setType(groupAllowed ? 'GROUP' : 'DIRECT');
    requestRef.current = null;
    store.clearChatCreateError();
    store.clearWorkspaceMembers();
    void store.loadChatLimits(true);
    // `groupAllowed` is intentionally read only when the dialog opens: a role
    // refresh while it is open must not wipe the user's input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, store]);

  useEffect(() => {
    if (!groupAllowed && type === 'GROUP') setType('DIRECT');
  }, [groupAllowed, type]);

  // Literal server-side search; the debounced value starts a new cursor chain.
  useEffect(() => {
    if (!open || type !== 'DIRECT') return;
    store.searchWorkspaceMembers(debouncedMemberQuery);
  }, [debouncedMemberQuery, open, store, type]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      if (type === 'GROUP') nameRef.current?.focus();
      else memberSearchRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, type]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!creating) onClose();
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
  }, [creating, onClose, open]);

  if (!open) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    const fingerprint = type === 'GROUP' ? `GROUP:${trimmed}` : `DIRECT:${peerId ?? ''}`;
    const key =
      requestRef.current?.fingerprint === fingerprint
        ? requestRef.current.key
        : (requestRef.current = { fingerprint, key: newUuid() }).key;
    const ok = await store.createChat(
      type === 'GROUP'
        ? { type: 'GROUP', name: trimmed }
        : { type: 'DIRECT', peerId: peerId ?? '' },
      key,
    );
    if (ok) {
      requestRef.current = null;
      onClose();
    }
  };

  const error = state.chatCreateError;
  const errorField = error?.details?.field;
  const errorText = error
    ? error.code === 'CHAT_LIMIT_REACHED'
      ? limitMessage(error.details)
      : error.status === 403
        ? t('chat.create.forbidden')
        : errorField === 'peer_id' || (type === 'DIRECT' && error.status === 400)
          ? t('chat.create.peerError')
          : error.status === 422 || error.code === 'VALIDATION_FAILED'
            ? t('chat.create.validation')
            : t('chat.create.error')
    : null;

  const handleMemberSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown') return;
    const first = memberListRef.current?.querySelector<HTMLInputElement>(
      'input[type="radio"]:not([disabled])',
    );
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const title = type === 'GROUP' ? t('chat.create.title') : t('chat.create.titleDirect');
  const lead = type === 'GROUP' ? t('chat.create.lead') : t('chat.create.leadDirect');

  return (
    <div
      className="create-chat-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="create-chat-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={-1}
      >
        <div className="create-chat-dialog__head">
          <div>
            <h2 className="create-chat-dialog__title" id={titleId}>
              {title}
            </h2>
            <p className="create-chat-dialog__lead" id={hintId}>
              {lead}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={creating}
            aria-label={t('chat.create.close')}
            title={t('chat.create.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <form
          className="create-chat-form"
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
        >
          <fieldset className="create-chat-form__type" disabled={creating}>
            <legend className="field__label">{t('chat.create.typeLabel')}</legend>
            <label
              className={`create-chat-type${type === 'GROUP' ? ' create-chat-type--active' : ''}`}
            >
              <input
                type="radio"
                name="chat-type"
                value="GROUP"
                checked={type === 'GROUP'}
                disabled={!groupAllowed}
                aria-label={t('chat.create.group')}
                aria-describedby={groupHintId}
                onChange={() => setType('GROUP')}
              />
              <span className="create-chat-type__body">
                <span className="create-chat-type__name">{t('chat.create.group')}</span>
                <span className="create-chat-type__hint" id={groupHintId}>
                  {groupAllowed ? t('chat.create.groupHint') : t('chat.create.groupForbidden')}
                </span>
              </span>
            </label>
            <label
              className={`create-chat-type${type === 'DIRECT' ? ' create-chat-type--active' : ''}`}
            >
              <input
                type="radio"
                name="chat-type"
                value="DIRECT"
                checked={type === 'DIRECT'}
                aria-label={t('chat.create.direct')}
                aria-describedby={directHintId}
                onChange={() => setType('DIRECT')}
              />
              <span className="create-chat-type__body">
                <span className="create-chat-type__name">{t('chat.create.direct')}</span>
                <span className="create-chat-type__hint" id={directHintId}>
                  {t('chat.create.directNote')}
                </span>
              </span>
            </label>
          </fieldset>

          {type === 'GROUP' ? (
            <div className="field">
              <label className="field__label" htmlFor={nameId}>
                {t('chat.create.nameLabel')}
              </label>
              <input
                ref={nameRef}
                id={nameId}
                className="field__input"
                type="text"
                value={name}
                maxLength={MAX_NAME_LENGTH}
                placeholder={t('chat.create.namePlaceholder')}
                autoComplete="off"
                disabled={creating}
                aria-describedby={`${nameId}-hint${showValidation ? ` ${nameErrorId}` : ''}`}
                aria-invalid={showValidation}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setTouched(true)}
              />
              <div className="field__meta">
                <span id={`${nameId}-hint`}>{t('chat.create.nameHint')}</span>
                <span aria-hidden="true">{t('chat.create.counter', { count: name.length })}</span>
              </div>
              {showValidation ? (
                <p className="field__error" id={nameErrorId} role="alert">
                  {t('chat.create.validation')}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="create-chat-members">
              <div className="field">
                <label className="field__label" htmlFor={memberSearchId}>
                  {t('chat.create.memberSearch')}
                </label>
                <input
                  ref={memberSearchRef}
                  id={memberSearchId}
                  className="field__input"
                  type="search"
                  value={memberQuery}
                  maxLength={MAX_MEMBER_QUERY_LENGTH}
                  placeholder={t('chat.create.memberSearchPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={creating}
                  aria-describedby={memberSearchHintId}
                  onChange={(event) => setMemberQuery(event.target.value)}
                  onKeyDown={handleMemberSearchKeyDown}
                />
                <div className="field__meta">
                  <span id={memberSearchHintId}>{t('chat.create.memberSearchHint')}</span>
                  {memberStatus === 'ready' ? (
                    <span id={memberCountId} role="status">
                      {t('chat.create.memberCount', { count: members.length })}
                    </span>
                  ) : null}
                </div>
              </div>

              <fieldset
                ref={memberListRef}
                className="create-chat-members__fieldset"
                aria-describedby={memberStatus === 'ready' ? memberCountId : undefined}
                disabled={creating}
              >
                <legend className="field__label">{t('chat.create.memberLabel')}</legend>

                {showMemberSkeleton ? (
                  <div className="create-chat-members__skeleton" role="status" aria-live="polite">
                    <span className="visually-hidden">{t('chat.create.memberLoading')}</span>
                    {[0, 1, 2].map((index) => (
                      <span className="create-chat-members__skeleton-row" key={index}>
                        <span className="skeleton create-chat-members__skeleton-name" />
                        <span className="skeleton create-chat-members__skeleton-role" />
                      </span>
                    ))}
                  </div>
                ) : null}

                {showMemberError ? (
                  <div className="create-chat-members__state" role="alert">
                    <p>
                      {state.workspaceMembers.error?.status === 403
                        ? t('chat.create.memberForbidden')
                        : t('chat.create.memberError')}
                    </p>
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={creating}
                      onClick={() =>
                        void store.loadWorkspaceMembers({
                          query: state.workspaceMembers.query,
                          force: true,
                        })
                      }
                    >
                      {t('common.retry')}
                    </button>
                  </div>
                ) : null}

                {showMemberEmpty ? (
                  <p className="create-chat-members__empty" role="status">
                    {memberQueryActive
                      ? t('chat.create.memberEmptySearch', {
                          query: memberQuery.trim(),
                        })
                      : t('chat.create.memberEmpty')}
                  </p>
                ) : null}

                {members.length > 0 && !showMemberSkeleton ? (
                  <div className="create-chat-members__list">
                    {members.map((member) => (
                      <label className="create-chat-member" key={member.user_id}>
                        <input
                          type="radio"
                          name="direct-peer"
                          value={member.user_id}
                          checked={peerId === member.user_id}
                          onChange={() => setPeerId(member.user_id)}
                        />
                        <span className="create-chat-member__body">
                          <span className="create-chat-member__name">{member.display_name}</span>
                          <span
                            className={`create-chat-member__role create-chat-member__role--${member.role.toLowerCase()}`}
                          >
                            {memberRoleLabel(member.role)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {showMemberStaleError ? (
                  <p className="create-chat-members__inline-error" role="alert">
                    {t('chat.create.memberError')}{' '}
                    <button
                      type="button"
                      className="admin-inline-link"
                      onClick={() =>
                        void store.loadWorkspaceMembers({
                          query: state.workspaceMembers.query,
                          force: true,
                        })
                      }
                    >
                      {t('common.retry')}
                    </button>
                  </p>
                ) : null}
              </fieldset>

              {state.workspaceMembers.hasMore && members.length > 0 ? (
                <div className="create-chat-members__more">
                  {state.workspaceMembers.loadMoreError ? (
                    <>
                      <p className="create-chat-members__inline-error" role="alert">
                        {t('chat.create.memberLoadMoreError')}
                      </p>
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => void store.loadMoreWorkspaceMembers()}
                      >
                        {t('common.retry')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={creating || state.workspaceMembers.loadMoreStatus === 'loading'}
                      onClick={() => void store.loadMoreWorkspaceMembers()}
                    >
                      {state.workspaceMembers.loadMoreStatus === 'loading'
                        ? t('chat.create.memberLoadingMore')
                        : t('chat.create.memberMore')}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <div className="create-chat-limits" aria-live="polite">
            {state.chatLimitsStatus === 'loading' && !limits ? (
              <p className="create-chat-limits__text">{t('chat.create.limitLoading')}</p>
            ) : null}
            {state.chatLimitsStatus === 'error' && !limits ? (
              <p className="create-chat-limits__text create-chat-limits__text--error">
                {t('chat.create.limitError')}{' '}
                <button
                  type="button"
                  className="admin-inline-link"
                  onClick={() => void store.loadChatLimits(true)}
                >
                  {t('common.retry')}
                </button>
              </p>
            ) : null}
            {used !== null && max !== null ? (
              <>
                <p className="create-chat-limits__text">
                  {t('chat.create.limitUsage', { used, limit: max })}
                  {limitReached ? ` — ${t('chat.create.limitReachedGeneric')}` : ''}
                </p>
                <div
                  className={`create-chat-limits__bar${limitReached ? ' create-chat-limits__bar--full' : ''}`}
                  role="progressbar"
                  aria-label={t('chat.create.limitUsage', { used, limit: max })}
                  aria-valuemin={0}
                  aria-valuemax={max}
                  aria-valuenow={Math.min(used, max)}
                >
                  <span
                    className="create-chat-limits__fill"
                    style={{ width: `${max > 0 ? Math.min(100, (used / max) * 100) : 0}%` }}
                  />
                </div>
                <p className="create-chat-limits__hint">{t('chat.create.limitHint')}</p>
              </>
            ) : null}
            {!groupAllowed && type === 'GROUP' ? (
              <p className="create-chat-limits__text create-chat-limits__text--error" role="alert">
                {t('chat.create.forbidden')}
              </p>
            ) : null}
          </div>

          {errorText ? (
            <p className="admin-form__error" role="alert">
              {errorText}
            </p>
          ) : null}

          <div className="create-chat-form__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
              disabled={creating}
            >
              {t('chat.create.cancel')}
            </button>
            <button type="submit" className="button button--primary" disabled={!canSubmit}>
              {creating ? t('chat.create.submitting') : t('chat.create.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
