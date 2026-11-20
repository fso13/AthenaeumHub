import { useEffect, useId, useState } from 'react';
import type { ApiError } from '../../api/problem';
import type { AdminUser, AdminUserStatus } from '../../api/types';
import { formatBytes } from '../../files/format';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { t, type MessageKey } from '../../i18n/ru';
import {
  useAdminDirectoryState,
  useAdminDirectoryStore,
  useChatState,
} from '../../store/ChatProvider';
import { AdminConfirmDialog } from './AdminConfirmDialog';
import { AdminSessionsDialog } from './AdminSessionsDialog';
import { AdminEmptyState, AdminErrorState, AdminListCount, AdminSkeleton } from './AdminStates';
import { AdminCell, AdminRow, AdminRowsHead } from './AdminListParts';
import { describeAdminActionError, type AdminActionErrorInfo } from './actionErrors';
import { formatCount, formatDateTime } from './format';

function statusKey(status: AdminUserStatus): MessageKey {
  switch (status) {
    case 'SUSPENDED':
      return 'admin.users.status.SUSPENDED';
    case 'DELETED':
      return 'admin.users.status.DELETED';
    default:
      return 'admin.users.status.ACTIVE';
  }
}

const COLUMNS: MessageKey[] = [
  'admin.users.column.email',
  'admin.users.column.name',
  'admin.users.column.status',
  'admin.users.column.admin',
  'admin.users.column.workspaces',
  'admin.users.column.chats',
  'admin.users.column.storage',
  'admin.users.column.created',
  'admin.users.column.actions',
];

const SEARCH_MAX_LENGTH = 254;

type UserActionKind = 'suspend' | 'activate';

interface PendingUserAction {
  user: AdminUser;
  kind: UserActionKind;
}

interface SectionNotice {
  tone: 'ok' | 'warning';
  text: string;
}

/**
 * Action offered by the row for the current status. `DELETED` has no action:
 * the contract exposes no restore and the server answers `404` for deleted
 * users, so the UI must not invent one.
 */
function actionFor(status: AdminUserStatus): UserActionKind | null {
  if (status === 'ACTIVE') return 'suspend';
  if (status === 'SUSPENDED') return 'activate';
  return null;
}

/**
 * UX guard only — `PlatformAdminGuard` and `ChangeUserStatusService` remain the
 * source of truth (`SELF_ACTION_FORBIDDEN`, `LAST_PLATFORM_ADMIN`).
 */
function blockedReasonKey(user: AdminUser, selfId: string | undefined): MessageKey | null {
  if (user.status === 'DELETED') return 'admin.users.action.deleted';
  if (selfId !== undefined && user.id === selfId) return 'admin.users.action.self';
  if (user.is_platform_admin) return 'admin.users.action.platformAdmin';
  return null;
}

/**
 * `/admin?tab=users` (FR-ADM-10, E11-F FR-ADM-15).
 *
 * Server-side literal search + opaque cursor; the client only echoes
 * `next_cursor` and never derives users from chats. Suspend/activate require an
 * explicit confirm naming the target email, keep the row on failure, and
 * re-read the page after the server answers (no optimistic flip).
 */
export function AdminUsersSection() {
  const store = useAdminDirectoryStore();
  const { users } = useAdminDirectoryState();
  const selfId = useChatState().me?.user.id;
  const [draft, setDraft] = useState(users.query);
  const debounced = useDebouncedValue(draft, 300);
  const [pending, setPending] = useState<PendingUserAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AdminActionErrorInfo | null>(null);
  const [actionErrorDetails, setActionErrorDetails] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const [sessionsUser, setSessionsUser] = useState<AdminUser | null>(null);
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    void store.loadUsers();
  }, [store]);

  useEffect(() => {
    store.setUsersQuery(debounced);
  }, [debounced, store]);

  const showSkeleton = users.status === 'loading' && users.items.length === 0;
  const forbidden = users.error?.status === 403;
  const emptyBySearch = users.query.length > 0;

  const openDialog = (user: AdminUser, kind: UserActionKind) => {
    setNotice(null);
    setActionError(null);
    setActionErrorDetails(null);
    setPending({ user, kind });
  };

  const closeDialog = () => {
    setPending(null);
    setActionError(null);
    setActionErrorDetails(null);
  };

  const confirmAction = async () => {
    if (!pending) return;
    const target = pending.user;
    const status: Extract<AdminUserStatus, 'ACTIVE' | 'SUSPENDED'> =
      pending.kind === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    setBusy(true);
    setActionError(null);
    setActionErrorDetails(null);

    const result = await store.changeUserStatus(target.id, status);
    setBusy(false);

    if (result.ok) {
      closeDialog();
      setNotice({
        tone: 'ok',
        text: t(
          pending.kind === 'suspend'
            ? 'admin.users.notice.suspended'
            : 'admin.users.notice.activated',
          { email: target.email ?? target.display_name },
        ),
      });
      return;
    }

    const info = result.error
      ? describeAdminActionError(result.error, 'user')
      : {
          text: t('admin.actions.error.generic'),
          tone: 'error' as const,
          retryable: false,
          closeOnError: false,
        };
    if (info.closeOnError) {
      // Server state already holds the target state; the list was refreshed.
      closeDialog();
      setNotice({ tone: info.tone === 'warning' ? 'warning' : 'ok', text: info.text });
      return;
    }
    setActionError(info);
    setActionErrorDetails(result.error);
  };

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-users-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-users-title">
            {t('admin.users.title')}
          </h2>
          <p className="admin-card__lead">{t('admin.users.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadUsers({ force: true })}
          disabled={users.status === 'loading'}
        >
          {t('admin.refresh')}
        </button>
      </div>

      <div className="admin-toolbar">
        <div className="field admin-search">
          <label className="field__label" htmlFor={inputId}>
            {t('admin.users.search')}
          </label>
          <input
            id={inputId}
            className="field__input"
            type="search"
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="field__meta" id={hintId}>
            {t('admin.users.searchHint')}
          </p>
        </div>
        {draft.length > 0 ? (
          <button
            type="button"
            className="button button--ghost admin-toolbar__action"
            onClick={() => setDraft('')}
          >
            {t('admin.users.clear')}
          </button>
        ) : null}
      </div>

      {notice ? (
        <p className={`admin-notice admin-notice--${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}

      {showSkeleton ? <AdminSkeleton label={t('admin.users.loading')} /> : null}

      {users.status === 'error' && users.items.length > 0 ? (
        <div className="admin-state admin-state--error" role="alert">
          <p>{forbidden ? t('admin.forbidden.text') : t('admin.users.error')}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void store.loadUsers({ force: true })}
          >
            {t('admin.users.retry')}
          </button>
        </div>
      ) : null}

      {users.status === 'error' && users.items.length === 0 ? (
        <AdminErrorState
          text={forbidden ? t('admin.forbidden.text') : t('admin.users.error')}
          error={users.error}
          retryLabel={t('admin.users.retry')}
          onRetry={() => void store.loadUsers({ force: true })}
        />
      ) : null}

      {users.status === 'ready' && users.items.length === 0 ? (
        <AdminEmptyState
          title={t(emptyBySearch ? 'admin.users.emptyTitle' : 'admin.users.emptyAllTitle')}
          text={t(emptyBySearch ? 'admin.users.emptyText' : 'admin.users.emptyAllText')}
        />
      ) : null}

      {users.items.length > 0 ? (
        <>
          <AdminListCount label={t('admin.users.count', { count: users.items.length })} />
          <div className="admin-rows admin-rows--users">
            <AdminRowsHead labels={COLUMNS.map((key) => t(key))} />
            <ul className="admin-rows__items">
              {users.items.map((user) => {
                const action = actionFor(user.status);
                const blocked = blockedReasonKey(user, selfId);
                return (
                  <AdminRow key={user.id}>
                    <AdminCell label={t('admin.users.column.email')} primary>
                      <span className="admin-cell__strong">{user.email ?? '—'}</span>
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.name')}>{user.display_name}</AdminCell>
                    <AdminCell label={t('admin.users.column.status')}>
                      <span className={`admin-chip admin-chip--${user.status.toLowerCase()}`}>
                        {t(statusKey(user.status))}
                      </span>
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.admin')}>
                      {user.is_platform_admin ? (
                        <span className="admin-chip admin-chip--ok">
                          {t('admin.users.adminBadge')}
                        </span>
                      ) : (
                        <span className="admin-cell__muted">{t('admin.users.notAdmin')}</span>
                      )}
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.workspaces')}>
                      {formatCount(user.workspaces_count)}
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.chats')}>
                      {formatCount(user.chats_count)}
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.storage')}>
                      {formatBytes(user.storage_used_bytes)}
                    </AdminCell>
                    <AdminCell label={t('admin.users.column.created')}>
                      <time dateTime={user.created_at}>{formatDateTime(user.created_at)}</time>
                    </AdminCell>
                    <AdminCell
                      label={t('admin.users.column.actions')}
                      className="admin-cell--actions"
                    >
                      {action === null ? (
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          disabled
                          title={t('admin.users.action.deleted')}
                        >
                          {t('admin.users.action.none')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button button--secondary button--small"
                            onClick={() => setSessionsUser(user)}
                            disabled={busy || user.status === 'DELETED'}
                            title={t('admin.sessions.open')}
                          >
                            {t('admin.sessions.open')}
                          </button>
                          <button
                            type="button"
                            className={`button button--small ${
                              action === 'suspend' ? 'button--danger-ghost' : 'button--secondary'
                            }`}
                            onClick={() => openDialog(user, action)}
                            disabled={busy || blocked !== null}
                            title={blocked ? t(blocked) : t(`admin.users.action.${action}`)}
                          >
                            {t(`admin.users.action.${action}`)}
                          </button>
                          {blocked ? <span className="admin-cell__sub">{t(blocked)}</span> : null}
                        </>
                      )}
                    </AdminCell>
                  </AdminRow>
                );
              })}
            </ul>
          </div>

          {users.moreError ? (
            <div className="admin-more">
              <p className="admin-state admin-state--error-inline" role="alert">
                {t('admin.users.loadMoreError')}
              </p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreUsers()}
              >
                {t('admin.users.retry')}
              </button>
            </div>
          ) : users.hasMore ? (
            <div className="admin-more">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreUsers()}
                disabled={users.loadingMore}
              >
                {t(users.loadingMore ? 'admin.users.loadingMore' : 'admin.users.loadMore')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {pending ? (
        <AdminConfirmDialog
          title={t(
            pending.kind === 'suspend'
              ? 'admin.users.confirm.suspendTitle'
              : 'admin.users.confirm.activateTitle',
          )}
          description={
            <>
              <p className="admin-confirm__lead">
                {t(
                  pending.kind === 'suspend'
                    ? 'admin.users.confirm.suspendLead'
                    : 'admin.users.confirm.activateLead',
                  { email: pending.user.email ?? pending.user.display_name },
                )}
              </p>
              <ul className="admin-confirm__list">
                <li>
                  {t(
                    pending.kind === 'suspend'
                      ? 'admin.users.confirm.suspendEffect'
                      : 'admin.users.confirm.activateEffect',
                  )}
                </li>
                <li>{t('admin.users.confirm.audited')}</li>
              </ul>
              {pending.user.is_platform_admin ? (
                <p className="admin-confirm__hint">{t('admin.users.confirm.adminTarget')}</p>
              ) : null}
            </>
          }
          confirmLabel={t(
            pending.kind === 'suspend'
              ? 'admin.users.confirm.suspendConfirm'
              : 'admin.users.confirm.activateConfirm',
          )}
          busyLabel={t(
            pending.kind === 'suspend'
              ? 'admin.users.confirm.suspending'
              : 'admin.users.confirm.activating',
          )}
          destructive={pending.kind === 'suspend'}
          busy={busy}
          error={actionError}
          errorDetails={actionErrorDetails}
          onConfirm={() => void confirmAction()}
          onClose={closeDialog}
        />
      ) : null}

      {sessionsUser ? (
        <AdminSessionsDialog
          user={sessionsUser}
          onClose={() => {
            store.closeSessions();
            setSessionsUser(null);
          }}
        />
      ) : null}
    </section>
  );
}
