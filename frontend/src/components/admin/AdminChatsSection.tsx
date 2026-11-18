import { useEffect, useId, useState } from 'react';
import type { ApiError } from '../../api/problem';
import type { AdminChat } from '../../api/types';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { t, type MessageKey } from '../../i18n/ru';
import { useAdminDirectoryState, useAdminDirectoryStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from './AdminConfirmDialog';
import { AdminEmptyState, AdminErrorState, AdminListCount, AdminSkeleton } from './AdminStates';
import { AdminCell, AdminRow, AdminRowsHead } from './AdminListParts';
import { describeAdminActionError, type AdminActionErrorInfo } from './actionErrors';
import { formatCount, formatDateTime } from './format';
import type { AdminChatTypeFilter } from '../../ops/adminDirectory';

const COLUMNS: MessageKey[] = [
  'admin.chats.column.workspace',
  'admin.chats.column.name',
  'admin.chats.column.type',
  'admin.chats.column.mode',
  'admin.chats.column.members',
  'admin.chats.column.messages',
  'admin.chats.column.lastActivity',
  'admin.chats.column.actions',
];

const SEARCH_MAX_LENGTH = 120;

/**
 * `/admin?tab=chats` (FR-ADM-11). The workspace filter is fed by the storage
 * snapshot (one row per undeleted workspace) because the contract has no
 * separate admin workspace directory; already loaded chat rows are merged in as
 * a fallback so the filter still works when storage is unavailable.
 */
export function AdminChatsSection() {
  const store = useAdminDirectoryStore();
  const { chats, storage } = useAdminDirectoryState();
  const [draft, setDraft] = useState(chats.query);
  const debounced = useDebouncedValue(draft, 300);
  const searchId = useId();
  const searchHintId = useId();
  const workspaceId = useId();
  const typeId = useId();
  const [pendingDelete, setPendingDelete] = useState<AdminChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AdminActionErrorInfo | null>(null);
  const [actionErrorDetails, setActionErrorDetails] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    void store.loadChats();
    // Filter options come from the storage aggregates; the read is audited as
    // `admin.storage.viewed` (counters only) and cached for the session.
    void store.loadStorage();
  }, [store]);

  useEffect(() => {
    store.setChatsFilters({ query: debounced });
  }, [debounced, store]);

  const workspaceOptions: Array<{ id: string; name: string }> = [];
  const known = new Set<string>();
  for (const row of storage.data?.workspaces ?? []) {
    known.add(row.workspace_id);
    workspaceOptions.push({ id: row.workspace_id, name: row.workspace_name });
  }
  for (const chat of chats.items) {
    if (known.has(chat.workspace_id)) continue;
    known.add(chat.workspace_id);
    workspaceOptions.push({ id: chat.workspace_id, name: chat.workspace_name });
  }

  const hasFilters = chats.query.length > 0 || chats.workspaceId !== null || chats.type !== 'ALL';

  const chatLabel = (chat: AdminChat): string =>
    chat.name ?? `${t('admin.chats.unnamed')} · ${chat.workspace_name}`;

  const openDelete = (chat: AdminChat) => {
    setNotice(null);
    setActionError(null);
    setActionErrorDetails(null);
    setPendingDelete(chat);
  };

  const closeDelete = () => {
    setPendingDelete(null);
    setActionError(null);
    setActionErrorDetails(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusy(true);
    setActionError(null);
    setActionErrorDetails(null);

    const result = await store.deleteChat(target.id);
    setBusy(false);

    if (result.ok) {
      closeDelete();
      setNotice({
        tone: 'ok',
        text: t('admin.chats.notice.deleted', { name: chatLabel(target) }),
      });
      return;
    }

    const info = result.error
      ? describeAdminActionError(result.error, 'chat')
      : {
          text: t('admin.actions.error.generic'),
          tone: 'error' as const,
          retryable: false,
          closeOnError: false,
        };
    if (info.closeOnError) {
      closeDelete();
      setNotice({ tone: info.tone === 'warning' ? 'warning' : 'ok', text: info.text });
      return;
    }
    setActionError(info);
    setActionErrorDetails(result.error);
  };

  const showSkeleton = chats.status === 'loading' && chats.items.length === 0;
  const forbidden = chats.error?.status === 403;

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-chats-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-chats-title">
            {t('admin.chats.title')}
          </h2>
          <p className="admin-card__lead">{t('admin.chats.lead')}</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void store.loadChats({ force: true })}
          disabled={chats.status === 'loading'}
        >
          {t('admin.refresh')}
        </button>
      </div>

      <div className="admin-toolbar admin-toolbar--chats">
        <div className="field">
          <label className="field__label" htmlFor={workspaceId}>
            {t('admin.chats.workspace')}
          </label>
          <select
            id={workspaceId}
            className="field__input admin-select"
            value={chats.workspaceId ?? ''}
            onChange={(event) => store.setChatsFilters({ workspaceId: event.target.value || null })}
          >
            <option value="">{t('admin.chats.workspaceAll')}</option>
            {workspaceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={typeId}>
            {t('admin.chats.type')}
          </label>
          <select
            id={typeId}
            className="field__input admin-select"
            value={chats.type}
            onChange={(event) =>
              store.setChatsFilters({ type: event.target.value as AdminChatTypeFilter })
            }
          >
            <option value="ALL">{t('admin.chats.typeAll')}</option>
            <option value="DIRECT">{t('admin.chats.type.DIRECT')}</option>
            <option value="GROUP">{t('admin.chats.type.GROUP')}</option>
          </select>
        </div>

        <div className="field admin-search">
          <label className="field__label" htmlFor={searchId}>
            {t('admin.chats.search')}
          </label>
          <input
            id={searchId}
            className="field__input"
            type="search"
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            aria-describedby={searchHintId}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="field__meta" id={searchHintId}>
            {t('admin.chats.searchHint')}
          </p>
        </div>

        {hasFilters ? (
          <button
            type="button"
            className="button button--ghost admin-toolbar__action"
            onClick={() => {
              setDraft('');
              store.setChatsFilters({ query: '', workspaceId: null, type: 'ALL' });
            }}
          >
            {t('admin.users.clear')}
          </button>
        ) : null}
      </div>

      <p className="admin-card__hint">{t('admin.chats.filterHint')}</p>

      {notice ? (
        <p className={`admin-notice admin-notice--${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}

      {showSkeleton ? <AdminSkeleton label={t('admin.chats.loading')} /> : null}

      {chats.status === 'error' && chats.items.length > 0 ? (
        <div className="admin-state admin-state--error" role="alert">
          <p>{forbidden ? t('admin.forbidden.text') : t('admin.chats.error')}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void store.loadChats({ force: true })}
          >
            {t('admin.chats.retry')}
          </button>
        </div>
      ) : null}

      {chats.status === 'error' && chats.items.length === 0 ? (
        <AdminErrorState
          text={forbidden ? t('admin.forbidden.text') : t('admin.chats.error')}
          error={chats.error}
          retryLabel={t('admin.chats.retry')}
          onRetry={() => void store.loadChats({ force: true })}
        />
      ) : null}

      {chats.status === 'ready' && chats.items.length === 0 ? (
        <AdminEmptyState
          title={t(hasFilters ? 'admin.chats.emptyTitle' : 'admin.chats.emptyAllTitle')}
          text={t(hasFilters ? 'admin.chats.emptyText' : 'admin.chats.emptyAllText')}
        />
      ) : null}

      {chats.items.length > 0 ? (
        <>
          <AdminListCount label={t('admin.chats.count', { count: chats.items.length })} />
          <div className="admin-rows admin-rows--chats">
            <AdminRowsHead labels={COLUMNS.map((key) => t(key))} />
            <ul className="admin-rows__items">
              {chats.items.map((chat) => (
                <AdminRow key={chat.id}>
                  <AdminCell label={t('admin.chats.column.workspace')} primary>
                    <span className="admin-cell__strong">{chat.workspace_name}</span>
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.name')}>
                    {chat.name ?? t('admin.chats.unnamed')}
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.type')}>
                    <span className="admin-chip admin-chip--muted">
                      {t(
                        chat.type === 'GROUP'
                          ? 'admin.chats.type.GROUP'
                          : 'admin.chats.type.DIRECT',
                      )}
                    </span>
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.mode')}>
                    <span
                      className={`security-badge security-badge--${chat.security_mode.toLowerCase()}`}
                    >
                      {t(chat.security_mode === 'E2EE' ? 'chat.e2ee' : 'chat.managed')}
                    </span>
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.members')}>
                    {formatCount(chat.members_count)}
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.messages')}>
                    <span title={t('admin.chats.messagesHint')}>
                      {formatCount(chat.messages_count)}
                    </span>
                  </AdminCell>
                  <AdminCell label={t('admin.chats.column.lastActivity')}>
                    {chat.last_activity_at ? (
                      <time dateTime={chat.last_activity_at}>
                        {formatDateTime(chat.last_activity_at)}
                      </time>
                    ) : (
                      <span className="admin-cell__muted">{t('admin.chats.noActivity')}</span>
                    )}
                  </AdminCell>
                  <AdminCell
                    label={t('admin.chats.column.actions')}
                    className="admin-cell--actions"
                  >
                    <button
                      type="button"
                      className="button button--small button--danger-ghost"
                      onClick={() => openDelete(chat)}
                      disabled={busy}
                    >
                      {t('admin.chats.action.delete')}
                    </button>
                  </AdminCell>
                </AdminRow>
              ))}
            </ul>
          </div>

          {chats.moreError ? (
            <div className="admin-more">
              <p className="admin-state admin-state--error-inline" role="alert">
                {t('admin.chats.loadMoreError')}
              </p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreChats()}
              >
                {t('admin.chats.retry')}
              </button>
            </div>
          ) : chats.hasMore ? (
            <div className="admin-more">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadMoreChats()}
                disabled={chats.loadingMore}
              >
                {t(chats.loadingMore ? 'admin.chats.loadingMore' : 'admin.chats.loadMore')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {pendingDelete ? (
        <AdminConfirmDialog
          title={t('admin.chats.confirm.deleteTitle')}
          description={
            <>
              <p className="admin-confirm__lead">{chatLabel(pendingDelete)}</p>
              <p className="admin-confirm__text">{t('admin.chats.confirm.deleteLead')}</p>
              <ul className="admin-confirm__list">
                <li>{t('admin.chats.confirm.deleteEffect')}</li>
                <li>{t('admin.chats.confirm.deleteAudited')}</li>
              </ul>
              <code className="admin-confirm__id" title={pendingDelete.id}>
                {pendingDelete.id}
              </code>
            </>
          }
          confirmLabel={t('admin.chats.confirm.deleteConfirm')}
          busyLabel={t('admin.chats.confirm.deleting')}
          destructive
          busy={busy}
          error={actionError}
          errorDetails={actionErrorDetails}
          onConfirm={() => void confirmDelete()}
          onClose={closeDelete}
        />
      ) : null}
    </section>
  );
}
