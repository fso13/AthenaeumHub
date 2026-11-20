import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { ChatMember, ChatMemberRole, ChatSummary, WorkspaceMember } from '../../api/types';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { t } from '../../i18n/ru';
import {
  assignableChatRoles,
  canManageChatMember,
  createEmptyChatMembersState,
  isChatManagerRole,
} from '../../store/chatStore';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from '../admin/actionErrors';
import { formatDateTime } from '../admin/format';
import { Avatar } from '../Avatar';
import { LogoutIcon, RefreshIcon } from '../Icons';
import { chatMembershipErrorText } from './errors';

const ROLE_LABEL: Record<ChatMemberRole, Parameters<typeof t>[0]> = {
  OWNER: 'chatMembers.role.OWNER',
  ADMIN: 'chatMembers.role.ADMIN',
  MODERATOR: 'chatMembers.role.MODERATOR',
  MEMBER: 'chatMembers.role.MEMBER',
  GUEST: 'chatMembers.role.GUEST',
};

const STATUS_LABEL: Record<ChatMember['status'], Parameters<typeof t>[0]> = {
  INVITED: 'chatMembers.status.INVITED',
  ACTIVE: 'chatMembers.status.ACTIVE',
  REMOVED: 'chatMembers.status.REMOVED',
};

function actionErrorInfo(
  error: Parameters<typeof chatMembershipErrorText>[0],
): AdminActionErrorInfo {
  return {
    text: chatMembershipErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    closeOnError: false,
  };
}

/** Server directory order for the candidate picker. */
function candidateLabel(member: WorkspaceMember): string {
  return member.display_name;
}

export interface ChatMembersPanelProps {
  chat: ChatSummary;
  /** Called after a successful self-leave so the dialog can close. */
  onLeft?: () => void;
  /** Keeps the parent Escape/focus trap out of a nested confirm dialog. */
  onNestedModalChange?: (open: boolean) => void;
}

/**
 * #79 channel participants.
 *
 * - Rows come from `GET /chats/{id}/members` (`display_name`, `role`, `status`,
 *   `joined_at`) and are replaced only by server responses.
 * - Add searches the ACTIVE workspace directory (existing E10 endpoint) and
 *   excludes members already in the channel.
 * - OWNER can assign any channel role; ADMIN only MODERATOR/MEMBER/GUEST and
 *   cannot touch OWNER/ADMIN rows. Self role change is never offered.
 * - Leave/remove ask for confirmation; `409 LAST_OWNER`, `403
 *   ROLE_CHANGE_FORBIDDEN` and `422 CHAT_MEMBERSHIP_UNSUPPORTED` stay visible.
 */
export function ChatMembersPanel({ chat, onLeft, onNestedModalChange }: ChatMembersPanelProps) {
  const store = useChatStore();
  const state = useChatState();
  const membersState =
    state.chatMembers.chatId === chat.id ? state.chatMembers : createEmptyChatMembersState();
  const directory = state.workspaceMembers;

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 300);
  const [candidateId, setCandidateId] = useState('');
  const [addRole, setAddRole] = useState<ChatMemberRole>('MEMBER');
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ChatMember | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const titleId = useId();
  const searchId = useId();
  const candidateId_ = useId();
  const addRoleId = useId();
  const listId = useId();

  const viewerId = state.user?.id ?? state.me?.user.id ?? state.session?.user.id ?? null;
  const viewerMember = membersState.items.find((member) => member.user_id === viewerId) ?? null;
  const actorRole = viewerMember?.role ?? null;
  const canManage = isChatManagerRole(actorRole);
  const roleOptions = assignableChatRoles(actorRole);
  const memberIds = useMemo(
    () => new Set(membersState.items.map((member) => member.user_id)),
    [membersState.items],
  );
  const candidates = directory.items.filter((member) => !memberIds.has(member.user_id));
  const directoryLoading = directory.status === 'loading';
  const directoryError = directory.status === 'error';
  const queryActive = query.trim().length > 0;
  const candidateHint = directoryLoading
    ? t('chatMembers.candidatesLoading')
    : directoryError
      ? t('chatMembers.directoryError')
      : candidates.length === 0
        ? queryActive
          ? t('chatMembers.candidateNoResults')
          : t('chatMembers.candidateEmpty')
        : null;
  const candidate = candidates.find((member) => member.user_id === candidateId) ?? null;
  const loading = membersState.status === 'loading';
  const showSkeleton = loading && membersState.items.length === 0;
  const showListError = membersState.status === 'error' && membersState.items.length === 0;
  const showStaleListError = membersState.status === 'error' && membersState.items.length > 0;
  const addError = membersState.addStatus === 'error' ? membersState.addError : null;
  const leaveError = membersState.leaveStatus === 'error' ? membersState.leaveError : null;
  const removeError =
    removeTarget && membersState.removeError?.userId === removeTarget.user_id
      ? membersState.removeError.error
      : null;
  const pending =
    membersState.addStatus === 'adding' ||
    membersState.rolePendingUserId !== null ||
    membersState.removePendingUserId !== null ||
    membersState.leaveStatus === 'leaving';

  useEffect(() => {
    if (membersState.chatId === chat.id && membersState.status !== 'idle') return;
    void store.loadChatMembers(chat.id);
  }, [chat.id, membersState.chatId, membersState.status, store]);

  useEffect(() => {
    if (!canManage) return;
    if (directory.query === debouncedQuery && directory.status !== 'idle') return;
    if (directory.status === 'idle' && debouncedQuery === '' && directory.query === '') {
      void store.loadWorkspaceMembers();
      return;
    }
    store.searchWorkspaceMembers(debouncedQuery);
  }, [canManage, debouncedQuery, directory.query, directory.status, store]);

  useEffect(() => {
    if (roleOptions.includes(addRole)) return;
    setAddRole(roleOptions[0] ?? 'MEMBER');
  }, [addRole, roleOptions]);

  useEffect(() => {
    // Keep the selection while a debounced search is in flight; only a settled
    // result that no longer contains the candidate clears it.
    if (directory.status !== 'ready') return;
    if (candidateId !== '' && !candidate) setCandidateId('');
  }, [candidate, candidateId, directory.status]);

  useEffect(() => {
    onNestedModalChange?.(removeTarget !== null || leaveOpen);
  }, [leaveOpen, onNestedModalChange, removeTarget]);

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || pending || !candidate || !roleOptions.includes(addRole)) return;
    setNotice(null);
    const ok = await store.addChatMember(chat.id, candidate.user_id, addRole);
    if (ok) {
      setCandidateId('');
      setNotice(t('chatMembers.added'));
    }
  };

  const handleRoleChange = (member: ChatMember, next: string) => {
    if (!roleOptions.includes(next as ChatMemberRole)) return;
    setNotice(null);
    void store.changeChatMemberRole(chat.id, member.user_id, next as ChatMemberRole).then((ok) => {
      if (ok) setNotice(t('chatMembers.roleChanged'));
    });
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    const ok = await store.removeChatMember(chat.id, removeTarget.user_id);
    if (!ok) return;
    setRemoveTarget(null);
    setNotice(t('chatMembers.removed'));
  };

  const handleConfirmLeave = async () => {
    const ok = await store.leaveChat(chat.id);
    if (!ok) return;
    setLeaveOpen(false);
    setNotice(t('chatMembers.left'));
    onLeft?.();
  };

  return (
    <section className="chat-members" aria-labelledby={titleId}>
      <div className="chat-members__head">
        <h3 className="chat-settings-section__title" id={titleId}>
          {t('chatMembers.title')}
        </h3>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void store.loadChatMembers(chat.id, true)}
          disabled={loading}
          aria-busy={loading}
        >
          <RefreshIcon aria-hidden="true" />
          {loading ? t('chatMembers.loading') : t('chatMembers.refresh')}
        </button>
      </div>
      <p className="pane-sub">{t('chatMembers.hint')}</p>

      {!canManage && membersState.status !== 'error' ? (
        <p className="chat-settings-readonly">{t('chatMembers.readOnly')}</p>
      ) : null}

      {notice ? (
        <p className="chat-settings-notice" role="status">
          {notice}
        </p>
      ) : null}
      {leaveError ? (
        <p className="chat-settings-error" role="alert">
          {chatMembershipErrorText(leaveError)}
        </p>
      ) : null}

      {showSkeleton ? (
        <div className="members-list__skeleton" role="status" aria-live="polite">
          <span className="visually-hidden">{t('chatMembers.loading')}</span>
          {[0, 1, 2].map((index) => (
            <span className="members-row members-row--skeleton" key={index}>
              <span className="skeleton members-row__skeleton-avatar" />
              <span className="skeleton members-row__skeleton-name" />
              <span className="skeleton members-row__skeleton-role" />
            </span>
          ))}
        </div>
      ) : null}

      {showListError ? (
        <div className="members-list__state" role="alert">
          <p>
            {membersState.error
              ? chatMembershipErrorText(membersState.error)
              : t('chatMembers.loadError')}
          </p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadChatMembers(chat.id, true)}
          >
            {t('chatMembers.retry')}
          </button>
        </div>
      ) : null}

      {membersState.status === 'ready' && membersState.items.length === 0 ? (
        <p className="card-empty" role="status">
          {t('chatMembers.empty')}
        </p>
      ) : null}

      {membersState.items.length > 0 && !showSkeleton ? (
        <ul className="members-list__items" id={listId}>
          {membersState.items.map((member) => {
            const editable = canManageChatMember(actorRole, viewerId, member);
            const isSelf = member.user_id === viewerId;
            const roleError =
              membersState.roleError?.userId === member.user_id
                ? membersState.roleError.error
                : null;
            const roleErrorId = `${listId}-role-error-${member.user_id}`;
            return (
              <li className="members-row" key={member.user_id}>
                <Avatar name={member.display_name} seed={member.user_id} size="md" />
                <div className="members-row__body">
                  <span className="members-row__name">
                    {member.display_name}
                    {isSelf ? (
                      <span className="members-row__you">{t('chatMembers.you')}</span>
                    ) : null}
                  </span>
                  <span className="members-row__meta">
                    <span
                      className={`members-row__role members-row__role--${member.role.toLowerCase()}`}
                    >
                      {t(ROLE_LABEL[member.role])}
                    </span>
                    <span className="chat-member__status">{t(STATUS_LABEL[member.status])}</span>
                    <span className="members-row__joined">
                      {t('chatMembers.joined', { date: formatDateTime(member.joined_at) })}
                    </span>
                  </span>
                </div>
                {editable ? (
                  <div className="members-row__actions">
                    <label className="visually-hidden" htmlFor={`${listId}-role-${member.user_id}`}>
                      {t('chatMembers.roleSelect', { name: member.display_name })}
                    </label>
                    <select
                      id={`${listId}-role-${member.user_id}`}
                      className="members-row__select"
                      value={member.role}
                      disabled={pending}
                      aria-describedby={roleError ? roleErrorId : undefined}
                      onChange={(event) => handleRoleChange(member, event.target.value)}
                    >
                      {roleOptions.map((option) => (
                        <option key={option} value={option}>
                          {t(ROLE_LABEL[option])}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button button--danger members-row__remove"
                      disabled={pending}
                      onClick={() => setRemoveTarget(member)}
                      aria-label={t('chatMembers.removeLabel', { name: member.display_name })}
                    >
                      {t('chatMembers.remove')}
                    </button>
                  </div>
                ) : null}
                {roleError ? (
                  <p className="members-row__error" id={roleErrorId} role="alert">
                    {chatMembershipErrorText(roleError)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {showStaleListError ? (
        <p className="members-list__inline-error" role="alert">
          {t('chatMembers.loadError')}{' '}
          <button
            type="button"
            className="admin-inline-link"
            onClick={() => void store.loadChatMembers(chat.id, true)}
          >
            {t('chatMembers.retry')}
          </button>
        </p>
      ) : null}

      {canManage ? (
        <div className="members-add">
          <h4 className="members-add__title">{t('chatMembers.addSection')}</h4>
          <form className="members-add__form" onSubmit={(event) => void handleAdd(event)}>
            <div className="members-add__fields">
              <div className="field">
                <label className="field__label" htmlFor={searchId}>
                  {t('chatMembers.searchLabel')}
                </label>
                <input
                  id={searchId}
                  className="field__input"
                  type="search"
                  value={query}
                  maxLength={80}
                  placeholder={t('chatMembers.searchPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  aria-describedby={`${searchId}-hint`}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="field__meta" id={`${searchId}-hint`}>
                  <span>{t('chatMembers.searchHint')}</span>
                </div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={candidateId_}>
                  {t('chatMembers.candidate')}
                </label>
                <select
                  id={candidateId_}
                  className="field__input"
                  value={candidateId}
                  disabled={pending || candidates.length === 0}
                  onChange={(event) => setCandidateId(event.target.value)}
                >
                  <option value="">{t('chatMembers.candidatePlaceholder')}</option>
                  {candidates.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {candidateLabel(member)}
                    </option>
                  ))}
                </select>
                {candidateHint ? (
                  <p className="members-add__hint" role={directoryError ? 'alert' : 'status'}>
                    {candidateHint}{' '}
                    {directoryError ? (
                      <button
                        type="button"
                        className="admin-inline-link"
                        onClick={() =>
                          void store.loadWorkspaceMembers({ query: query.trim(), force: true })
                        }
                      >
                        {t('common.retry')}
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <div className="field">
                <label className="field__label" htmlFor={addRoleId}>
                  {t('chatMembers.role')}
                </label>
                <select
                  id={addRoleId}
                  className="field__input"
                  value={addRole}
                  disabled={pending || roleOptions.length === 0}
                  onChange={(event) => {
                    if (roleOptions.includes(event.target.value as ChatMemberRole)) {
                      setAddRole(event.target.value as ChatMemberRole);
                    }
                  }}
                >
                  {roleOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(ROLE_LABEL[option])}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="members-add__hint">{t('chatMembers.addHint')}</p>
            {addError ? (
              <p className="members-add__error" role="alert">
                {chatMembershipErrorText(addError)}
              </p>
            ) : null}
            <div className="members-add__actions">
              <button
                type="submit"
                className="btn btn--accent btn--sm"
                disabled={
                  pending || directoryError || candidateId === '' || !roleOptions.includes(addRole)
                }
              >
                {membersState.addStatus === 'adding'
                  ? t('chatMembers.adding')
                  : t('chatMembers.add')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {viewerMember ? (
        <div className="chat-members__leave">
          <div>
            <b>{t('chatMembers.leave')}</b>
            <p className="pane-sub">{t('chatMembers.leaveHint')}</p>
          </div>
          <button
            type="button"
            className="btn btn--danger"
            disabled={pending}
            onClick={() => setLeaveOpen(true)}
          >
            <LogoutIcon aria-hidden="true" />
            {membersState.leaveStatus === 'leaving'
              ? t('chatMembers.leaving')
              : t('chatMembers.leave')}
          </button>
        </div>
      ) : null}

      {removeTarget ? (
        <AdminConfirmDialog
          title={t('chatMembers.removeConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatMembers.removeConfirmLead', { name: removeTarget.display_name })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatMembers.removeConfirmNote')}</li>
                <li>{t(ROLE_LABEL[removeTarget.role])}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatMembers.removeConfirm')}
          busyLabel={t('chatMembers.removing')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={membersState.removePendingUserId === removeTarget.user_id}
          error={removeError ? actionErrorInfo(removeError) : null}
          errorDetails={removeError}
          onConfirm={() => void handleConfirmRemove()}
          onClose={() => {
            if (membersState.removePendingUserId !== null) return;
            setRemoveTarget(null);
          }}
        />
      ) : null}

      {leaveOpen ? (
        <AdminConfirmDialog
          title={t('chatMembers.leaveConfirmTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('chatMembers.leaveConfirmLead', {
                  name: chat.name?.trim() || t('chat.group'),
                })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('chatMembers.leaveConfirmNote')}</li>
              </ul>
            </>
          }
          confirmLabel={t('chatMembers.leaveConfirm')}
          busyLabel={t('chatMembers.leaving')}
          cancelLabel={t('common.cancel')}
          destructive
          busy={membersState.leaveStatus === 'leaving'}
          error={leaveError ? actionErrorInfo(leaveError) : null}
          errorDetails={leaveError}
          onConfirm={() => void handleConfirmLeave()}
          onClose={() => {
            if (membersState.leaveStatus === 'leaving') return;
            setLeaveOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}
