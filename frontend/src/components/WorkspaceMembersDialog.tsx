import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../api/problem';
import type { AssignableMemberRole, WorkspaceMember, WorkspaceMemberRole } from '../api/types';
import { describeError } from '../domain/errors';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { t, type MessageKey } from '../i18n/ru';
import { isAssignableMemberRole } from '../store/chatStore';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { AdminConfirmDialog } from './admin/AdminConfirmDialog';
import type { AdminActionErrorInfo } from './admin/actionErrors';
import { formatDateTime } from './admin/format';
import { Avatar } from './Avatar';
import { CloseIcon, RefreshIcon } from './Icons';

const MAX_MEMBER_QUERY_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Roles offered by the add/change select; `OWNER` is never assignable. */
const OWNER_EDIT_ROLES: AssignableMemberRole[] = ['ADMIN', 'MEMBER', 'GUEST'];
const ADMIN_EDIT_ROLES: AssignableMemberRole[] = ['MEMBER', 'GUEST'];

const ROLE_LABEL: Record<WorkspaceMemberRole, MessageKey> = {
  OWNER: 'members.role.OWNER',
  ADMIN: 'members.role.ADMIN',
  MEMBER: 'members.role.MEMBER',
  GUEST: 'members.role.GUEST',
};

function numberFromDetails(
  details: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = details?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * E12-F (R-09 / FR-WS-4..7) translated API errors. The server owns role,
 * duplicate, limit, self and last-owner rules; the UI only explains the code.
 */
function memberErrorText(error: ApiError): string {
  if (error.status === 403) {
    return error.code === 'ROLE_CHANGE_FORBIDDEN'
      ? t('members.error.roleForbidden')
      : t('members.error.forbidden');
  }
  if (error.status === 404) {
    if (error.code === 'USER_NOT_FOUND') return t('members.error.userNotFound');
    return t('members.error.memberNotFound');
  }
  if (error.status === 409) {
    switch (error.code) {
      case 'MEMBER_ALREADY_EXISTS':
        return t('members.error.alreadyExists');
      case 'WORKSPACE_MEMBER_LIMIT_REACHED': {
        const used = numberFromDetails(error.details, 'used');
        const limit = numberFromDetails(error.details, 'limit');
        return used !== null && limit !== null
          ? t('members.error.limit', { used, limit })
          : t('members.error.limitGeneric');
      }
      case 'LAST_OWNER':
        return t('members.error.lastOwner');
      case 'SELF_ACTION_FORBIDDEN':
        return t('members.error.self');
      case 'ROLE_CHANGE_FORBIDDEN':
        return t('members.error.roleForbidden');
      default:
        return t('members.error.conflict');
    }
  }
  if (error.status === 400 || error.status === 422) {
    return error.details?.field === 'email'
      ? t('members.error.email')
      : t('members.error.validation');
  }
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('members.error.generic');
}

function memberListErrorText(error: ApiError | null): string {
  if (error?.status === 403) return t('members.noAccess');
  return t('members.loadError');
}

function actionErrorInfo(error: ApiError): AdminActionErrorInfo {
  return {
    text: memberErrorText(error),
    tone: 'error',
    retryable: error.isNetwork || error.status >= 500,
    // The row stays visible on every failure (requirement: no row loss).
    closeOnError: false,
  };
}

export interface WorkspaceMembersDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * E12-F members dialog.
 *
 * - OWNER/ADMIN get add/role/remove controls; every other role sees the same
 *   server directory read-only (no destructive controls are rendered).
 * - The list comes from `GET /workspaces/{id}/members` (display name, role,
 *   joined only); email exists only in the add form.
 * - Rows change only after a server success. Add/remove re-read the list;
 *   role change applies the `200` response. Failures keep the row intact.
 * - Modal semantics: focus trap, Escape, focus return, labelled/described,
 *   loading/empty/error states and a 390 px-friendly stacked layout.
 */
export function WorkspaceMembersDialog({ open, onClose }: WorkspaceMembersDialogProps) {
  const store = useChatStore();
  const state = useChatState();
  const admin = state.workspaceMemberAdmin;
  const members = state.workspaceMembers;

  const [memberQuery, setMemberQuery] = useState('');
  const debouncedQuery = useDebouncedValue(memberQuery, 300);
  const [email, setEmail] = useState('');
  const [addRole, setAddRole] = useState<AssignableMemberRole>('MEMBER');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmMember, setConfirmMember] = useState<WorkspaceMember | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const leadId = useId();
  const searchId = useId();
  const searchHintId = useId();
  const listId = useId();
  const addTitleId = useId();
  const emailId = useId();
  const addRoleId = useId();

  const actorRole = state.activeWorkspace?.role ?? null;
  const canManage = actorRole === 'OWNER' || actorRole === 'ADMIN';
  const addRoles = actorRole === 'OWNER' ? OWNER_EDIT_ROLES : ADMIN_EDIT_ROLES;
  const editRoles = actorRole === 'OWNER' ? OWNER_EDIT_ROLES : ADMIN_EDIT_ROLES;
  const viewerId = state.user?.id ?? state.me?.user.id ?? state.session?.user.id ?? null;
  const workspaceName = state.activeWorkspace?.name ?? state.session?.workspace.name ?? null;

  const pending =
    admin.addStatus === 'adding' ||
    admin.rolePendingUserId !== null ||
    admin.removePendingUserId !== null;
  const loading = members.status === 'loading';
  const showSkeleton = loading && members.items.length === 0;
  const showError = members.status === 'error' && members.items.length === 0;
  const showEmpty = members.status === 'ready' && members.items.length === 0;
  const showStaleError = members.status === 'error' && members.items.length > 0;
  const queryActive = members.query.trim().length > 0;
  const addError = admin.addStatus === 'error' ? admin.addError : null;
  const addErrorField = addError?.details?.field;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMemberQuery('');
    setEmail('');
    setAddRole('MEMBER');
    setNotice(null);
    setConfirmMember(null);
    store.clearWorkspaceMemberAdmin();
    store.clearWorkspaceMembers();
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, store]);

  // A new cursor chain per settled search value; the dialog opening also starts
  // the first page because the store is reset to `idle`.
  useEffect(() => {
    if (!open || debouncedQuery !== memberQuery) return;
    store.searchWorkspaceMembers(debouncedQuery);
  }, [debouncedQuery, memberQuery, open, store]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // The confirm dialog owns focus/Escape while it is mounted.
      if (confirmMember !== null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!pending) onClose();
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
  }, [confirmMember, onClose, open, pending]);

  useEffect(() => {
    // Clear the previous confirmation error when a new row is chosen.
    if (confirmMember) store.clearWorkspaceMemberAdmin();
  }, [confirmMember, store]);

  if (!open) return null;

  const handleRefresh = () => {
    void store.loadWorkspaceMembers({ query: members.query, force: true });
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const ok = await store.addWorkspaceMember(email, addRole);
    if (ok) {
      setEmail('');
      setNotice(t('members.added'));
      // The new row may be outside the current search; keep the form usable.
      searchRef.current?.focus();
    }
  };

  const handleRoleChange = (member: WorkspaceMember, next: string) => {
    if (!isAssignableMemberRole(next)) return;
    setNotice(null);
    void store.changeWorkspaceMemberRole(member.user_id, next).then((ok) => {
      if (ok) setNotice(t('members.roleChanged'));
    });
  };

  const handleConfirmRemove = async () => {
    if (!confirmMember) return;
    const ok = await store.removeWorkspaceMember(confirmMember.user_id);
    if (!ok) return;
    setConfirmMember(null);
    setNotice(t('members.removed'));
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  const canManageMember = (member: WorkspaceMember): boolean => {
    if (!canManage || member.user_id === viewerId) return false;
    if (member.role === 'OWNER') return false;
    if (actorRole === 'ADMIN' && member.role === 'ADMIN') return false;
    return true;
  };

  const removeError =
    confirmMember && admin.removeError?.userId === confirmMember.user_id
      ? admin.removeError.error
      : null;
  const confirmBusy = confirmMember !== null && admin.removePendingUserId === confirmMember.user_id;
  const roleErrorFor = (member: WorkspaceMember): ApiError | null =>
    admin.roleError?.userId === member.user_id ? admin.roleError.error : null;

  const countLabel = queryActive
    ? t('members.found', { count: members.items.length })
    : members.hasMore
      ? t('members.countPartial', { count: members.items.length })
      : t('members.count', { count: members.items.length });

  return (
    <div
      className="members-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="members-dialog__head">
          <div>
            <h2 className="members-dialog__title" id={titleId}>
              {t('members.title')}
            </h2>
            <p className="members-dialog__lead" id={leadId}>
              {workspaceName
                ? t('members.lead', { name: workspaceName })
                : t('members.leadGeneric')}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label={t('members.close')}
            title={t('members.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        {!canManage ? <p className="members-readonly">{t('members.readOnly')}</p> : null}

        <div className="members-toolbar">
          <div className="field members-toolbar__search">
            <label className="field__label" htmlFor={searchId}>
              {t('members.search')}
            </label>
            <input
              ref={searchRef}
              id={searchId}
              className="field__input"
              type="search"
              value={memberQuery}
              maxLength={MAX_MEMBER_QUERY_LENGTH}
              placeholder={t('members.searchPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-describedby={searchHintId}
              onChange={(event) => setMemberQuery(event.target.value)}
            />
            <div className="field__meta">
              <span id={searchHintId}>{t('members.searchHint')}</span>
              {members.status === 'ready' ? <span role="status">{countLabel}</span> : null}
            </div>
          </div>
          <button
            type="button"
            className="button button--secondary members-toolbar__refresh"
            onClick={handleRefresh}
            disabled={loading}
            aria-busy={loading}
          >
            <RefreshIcon aria-hidden="true" />
            {loading ? t('members.refreshing') : t('members.refresh')}
          </button>
        </div>

        {notice ? (
          <p className="members-notice" role="status">
            {notice}
          </p>
        ) : null}

        <section className="members-list" aria-labelledby={listId}>
          <h3 className="visually-hidden" id={listId}>
            {t('members.title')}
          </h3>

          {showSkeleton ? (
            <div className="members-list__skeleton" role="status" aria-live="polite">
              <span className="visually-hidden">{t('members.loading')}</span>
              {[0, 1, 2].map((index) => (
                <span className="members-row members-row--skeleton" key={index}>
                  <span className="skeleton members-row__skeleton-avatar" />
                  <span className="skeleton members-row__skeleton-name" />
                  <span className="skeleton members-row__skeleton-role" />
                </span>
              ))}
            </div>
          ) : null}

          {showError ? (
            <div className="members-list__state" role="alert">
              <p>{memberListErrorText(members.error)}</p>
              <button type="button" className="button button--secondary" onClick={handleRefresh}>
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          {showEmpty ? (
            <p className="members-list__empty" role="status">
              {queryActive
                ? t('members.emptySearch', { query: members.query.trim() })
                : t('members.empty')}
            </p>
          ) : null}

          {members.items.length > 0 && !showSkeleton ? (
            <ul className="members-list__items">
              {members.items.map((member) => {
                const editable = canManageMember(member);
                const roleError = roleErrorFor(member);
                const isSelf = member.user_id === viewerId;
                const roleErrorId = `${listId}-role-error-${member.user_id}`;
                return (
                  <li className="members-row" key={member.user_id}>
                    <Avatar name={member.display_name} seed={member.user_id} size="md" />
                    <div className="members-row__body">
                      <span className="members-row__name">
                        {member.display_name}
                        {isSelf ? (
                          <span className="members-row__you">{t('members.you')}</span>
                        ) : null}
                      </span>
                      <span className="members-row__meta">
                        <span
                          className={`members-row__role members-row__role--${member.role.toLowerCase()}`}
                        >
                          {t(ROLE_LABEL[member.role])}
                        </span>
                        <span className="members-row__joined">
                          {t('members.joined', { date: formatDateTime(member.joined_at) })}
                        </span>
                      </span>
                    </div>
                    {editable ? (
                      <div className="members-row__actions">
                        <label
                          className="visually-hidden"
                          htmlFor={`${listId}-role-${member.user_id}`}
                        >
                          {t('members.roleSelect', { name: member.display_name })}
                        </label>
                        <select
                          id={`${listId}-role-${member.user_id}`}
                          className="members-row__select"
                          value={member.role}
                          disabled={pending}
                          aria-describedby={roleError ? roleErrorId : undefined}
                          onChange={(event) => handleRoleChange(member, event.target.value)}
                        >
                          {editRoles.map((role) => (
                            <option key={role} value={role}>
                              {t(ROLE_LABEL[role])}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="button button--danger members-row__remove"
                          disabled={pending}
                          onClick={() => setConfirmMember(member)}
                          aria-label={t('members.removeLabel', {
                            name: member.display_name,
                          })}
                        >
                          {t('members.remove')}
                        </button>
                      </div>
                    ) : null}
                    {roleError ? (
                      <p className="members-row__error" id={roleErrorId} role="alert">
                        {memberErrorText(roleError)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {showStaleError ? (
            <p className="members-list__inline-error" role="alert">
              {t('members.loadError')}{' '}
              <button type="button" className="admin-inline-link" onClick={handleRefresh}>
                {t('common.retry')}
              </button>
            </p>
          ) : null}

          {members.hasMore && members.items.length > 0 ? (
            <div className="members-list__more">
              {members.loadMoreError ? (
                <>
                  <p className="members-list__inline-error" role="alert">
                    {t('members.loadMoreError')}
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
                  disabled={members.loadMoreStatus === 'loading'}
                  onClick={() => void store.loadMoreWorkspaceMembers()}
                >
                  {members.loadMoreStatus === 'loading'
                    ? t('members.loadingMore')
                    : t('members.more')}
                </button>
              )}
            </div>
          ) : null}
        </section>

        {canManage ? (
          <section className="members-add" aria-labelledby={addTitleId}>
            <h3 className="members-add__title" id={addTitleId}>
              {t('members.addSection')}
            </h3>
            <form
              className="members-add__form"
              onSubmit={(event) => void handleAdd(event)}
              noValidate
            >
              <div className="members-add__fields">
                <div className="field">
                  <label className="field__label" htmlFor={emailId}>
                    {t('members.email')}
                  </label>
                  <input
                    id={emailId}
                    className="field__input"
                    type="email"
                    inputMode="email"
                    value={email}
                    maxLength={MAX_EMAIL_LENGTH}
                    placeholder={t('members.emailPlaceholder')}
                    autoComplete="email"
                    spellCheck={false}
                    disabled={pending}
                    aria-invalid={addErrorField === 'email'}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={addRoleId}>
                    {t('members.role')}
                  </label>
                  <select
                    id={addRoleId}
                    className="field__input"
                    value={addRole}
                    disabled={pending}
                    onChange={(event) => {
                      if (isAssignableMemberRole(event.target.value)) {
                        setAddRole(event.target.value);
                      }
                    }}
                  >
                    {addRoles.map((role) => (
                      <option key={role} value={role}>
                        {t(ROLE_LABEL[role])}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="members-add__hint">{t('members.addHint')}</p>
              {addError ? (
                <p className="members-add__error" role="alert">
                  {memberErrorText(addError)}
                </p>
              ) : null}
              <div className="members-add__actions">
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pending || email.trim().length === 0}
                >
                  {admin.addStatus === 'adding' ? t('members.adding') : t('members.add')}
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </div>

      {confirmMember ? (
        <AdminConfirmDialog
          title={t('members.confirm.removeTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('members.confirm.removeLead', { name: confirmMember.display_name })}
              </p>
              <ul className="admin-confirm__list">
                <li>{t('members.confirm.removeEffect')}</li>
                <li>{t('members.confirm.removeAudited')}</li>
              </ul>
            </>
          }
          confirmLabel={t('members.confirm.removeConfirm')}
          busyLabel={t('members.confirm.removing')}
          cancelLabel={t('members.confirm.cancel')}
          destructive
          busy={confirmBusy}
          error={removeError ? actionErrorInfo(removeError) : null}
          errorDetails={removeError}
          onConfirm={() => void handleConfirmRemove()}
          onClose={() => {
            if (confirmBusy) return;
            setConfirmMember(null);
            store.clearWorkspaceMemberAdmin();
          }}
        />
      ) : null}
    </div>
  );
}
