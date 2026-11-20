import { useState } from 'react';
import type { WorkspaceSession } from '../../api/types';
import { t } from '../../i18n/ru';
import { describeSecurityActionError, securityErrorMessage } from '../../security/errors';
import { groupSessions, shortId } from '../../security/model';
import { useSecurityState, useSecurityStore } from '../../store/ChatProvider';
import { AdminConfirmDialog } from '../admin/AdminConfirmDialog';
import { formatDateTime } from '../admin/format';
import { ErrorDetails } from '../ErrorDetails';
import { RefreshIcon } from '../Icons';
import { SectionEmpty, SectionError, SectionLoading, SectionPagination } from './SecurityUi';

type DialogState = { kind: 'one'; session: WorkspaceSession } | { kind: 'all' } | null;

/**
 * Workspace member sessions. The contract exposes exactly id/user/device/
 * created/last_seen/current — there is no IP, username or token, so none can
 * be shown. Revocation is confirmed and reconciled from the server response;
 * the current session is labelled and revoke-all spares it (server-side).
 */
export function SessionsCard() {
  const store = useSecurityStore();
  const { sessions } = useSecurityState();
  const [dialog, setDialog] = useState<DialogState>(null);
  const groups = groupSessions(sessions.items);
  const loaded = sessions.status === 'ready';
  const revokeError = sessions.revokeError;
  const revokeAllError = sessions.revokeAllError;
  const dialogError =
    dialog?.kind === 'one'
      ? revokeError
        ? describeSecurityActionError(revokeError)
        : null
      : dialog?.kind === 'all'
        ? revokeAllError
          ? describeSecurityActionError(revokeAllError)
          : null
        : null;
  const dialogRawError =
    dialog?.kind === 'one' ? revokeError : dialog?.kind === 'all' ? revokeAllError : null;

  const closeDialog = () => {
    if (sessions.revokeStatus === 'revoking' || sessions.revokeAllStatus === 'revoking') return;
    store.clearRevokeError();
    store.clearRevokeAllError();
    setDialog(null);
  };

  const confirmOne = async (session: WorkspaceSession) => {
    const ok = await store.revokeSession(session.id);
    if (ok || store.getSnapshot().sessions.revokeError?.status === 404) {
      store.clearRevokeError();
      setDialog(null);
    }
  };

  const confirmAll = async () => {
    const result = await store.revokeAllSessions();
    if (result) {
      store.clearRevokeAllError();
      setDialog(null);
    }
  };

  return (
    <section className="card card--wide" aria-labelledby="security-sessions">
      <div className="card-head">
        <h2 className="card-title" id="security-sessions">
          {t('security.sessions.title')}
        </h2>
        <div className="sec-head-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadSessions(true)}
            disabled={sessions.status === 'loading'}
          >
            <RefreshIcon aria-hidden="true" />
            {t('security.refresh')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => {
              store.clearRevokeAllError();
              setDialog({ kind: 'all' });
            }}
            disabled={sessions.items.length === 0 || sessions.revokeAllStatus === 'revoking'}
          >
            {sessions.revokeAllStatus === 'revoking'
              ? t('security.sessions.revokingAll')
              : t('security.sessions.revokeAll')}
          </button>
        </div>
      </div>
      <p className="pane-sub">{t('security.sessions.lead')}</p>

      {sessions.revokeAllResult ? (
        <div className="sec-notice" role="status" aria-live="polite">
          <p>
            {t('security.sessions.revokeAllDone', {
              sessions: sessions.revokeAllResult.revoked_sessions,
              users: sessions.revokeAllResult.affected_users,
            })}
          </p>
        </div>
      ) : null}

      {revokeAllError && dialog?.kind !== 'all' ? (
        <div className="pg-inline-error" role="alert">
          <div>
            <p>{securityErrorMessage(revokeAllError, 'security.error.generic')}</p>
            <ErrorDetails error={revokeAllError} />
          </div>
          <button type="button" className="btn btn--sm" onClick={store.clearRevokeAllError}>
            {t('common.close')}
          </button>
        </div>
      ) : null}

      {revokeError && dialog?.kind !== 'one' ? (
        <div className="pg-inline-error" role="alert">
          <div>
            <p>{securityErrorMessage(revokeError, 'security.error.generic')}</p>
            <ErrorDetails error={revokeError} />
          </div>
          <button type="button" className="btn btn--sm" onClick={store.clearRevokeError}>
            {t('common.close')}
          </button>
        </div>
      ) : null}

      {sessions.status === 'loading' && !loaded ? (
        <SectionLoading label={t('security.sessions.loading')} />
      ) : null}

      {sessions.error ? (
        <SectionError
          text={
            sessions.error.code === 'AUTH_UNAVAILABLE'
              ? securityErrorMessage(sessions.error)
              : t('security.sessions.error')
          }
          error={sessions.error}
          onRetry={() => void store.loadSessions(true)}
          retryLabel={t('security.sessions.retry')}
        />
      ) : null}

      {loaded && sessions.items.length === 0 ? (
        <SectionEmpty
          title={t('security.sessions.emptyTitle')}
          text={t('security.sessions.emptyText')}
        />
      ) : null}

      {groups.length > 0 ? (
        <div className="sec-table-wrap">
          <table className="sec-table sec-table--sessions">
            <caption className="visually-hidden">{t('security.sessions.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('security.sessions.column.device')}</th>
                <th scope="col">{t('security.sessions.column.created')}</th>
                <th scope="col">{t('security.sessions.column.lastSeen')}</th>
                <th scope="col">{t('security.sessions.column.actions')}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.userId}>
                <tr className="sec-group-row">
                  <th scope="rowgroup" colSpan={4}>
                    <span>{t('security.sessions.group')}</span>
                    <code title={group.userId} aria-label={group.userId}>
                      {shortId(group.userId)}
                    </code>
                  </th>
                </tr>
                {group.sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <b>{session.device || '—'}</b>
                      {session.current ? (
                        <span className="chip chip--accent sec-current">
                          {t('security.sessions.current')}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <time dateTime={session.created_at}>
                        {formatDateTime(session.created_at)}
                      </time>
                    </td>
                    <td>
                      <time dateTime={session.last_seen_at}>
                        {formatDateTime(session.last_seen_at)}
                      </time>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        onClick={() => {
                          store.clearRevokeError();
                          setDialog({ kind: 'one', session });
                        }}
                        disabled={sessions.revokeStatus === 'revoking'}
                        aria-label={`${t('security.sessions.revoke')}: ${session.device || session.id}`}
                      >
                        {sessions.revokeStatus === 'revoking' && sessions.revokingId === session.id
                          ? t('security.sessions.revoking')
                          : t('security.sessions.revoke')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}

      <SectionPagination
        hasMore={sessions.hasMore}
        loadingMore={sessions.loadingMore}
        moreError={sessions.moreError}
        onLoadMore={() => void store.loadMoreSessions()}
        loadMoreLabel={t('security.sessions.loadMore')}
        loadingLabel={t('security.sessions.loadingMore')}
        errorLabel={t('security.sessions.loadMoreError')}
      />

      {dialog?.kind === 'one' ? (
        <AdminConfirmDialog
          title={t('security.sessions.revokeTitle')}
          description={
            <>
              <p className="admin-confirm__lead">
                {t('security.sessions.revokeText', {
                  device: dialog.session.device || '—',
                  user: shortId(dialog.session.user_id),
                })}
              </p>
              {dialog.session.current ? (
                <p className="admin-confirm__hint">{t('security.sessions.revokeCurrentText')}</p>
              ) : null}
            </>
          }
          confirmLabel={t('security.sessions.revokeConfirm')}
          busyLabel={t('security.sessions.revoking')}
          destructive
          busy={sessions.revokeStatus === 'revoking'}
          error={dialogError}
          errorDetails={dialogRawError}
          onConfirm={() => void confirmOne(dialog.session)}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.kind === 'all' ? (
        <AdminConfirmDialog
          title={t('security.sessions.revokeAllTitle')}
          description={
            <p className="admin-confirm__lead">{t('security.sessions.revokeAllText')}</p>
          }
          confirmLabel={t('security.sessions.revokeAllConfirm')}
          busyLabel={t('security.sessions.revokingAll')}
          destructive
          busy={sessions.revokeAllStatus === 'revoking'}
          error={dialogError}
          errorDetails={dialogRawError}
          onConfirm={() => void confirmAll()}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
