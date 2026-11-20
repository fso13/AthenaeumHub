import { useEffect, useId, useRef, useState } from 'react';
import type { ApiError } from '../../api/problem';
import type { AdminUser } from '../../api/types';
import { t } from '../../i18n/ru';
import { useAdminDirectoryState, useAdminDirectoryStore } from '../../store/ChatProvider';
import { ErrorDetails } from '../ErrorDetails';
import { CloseIcon, RefreshIcon, ShieldIcon } from '../Icons';
import { AdminEmptyState, AdminErrorState, AdminSkeleton } from './AdminStates';
import { formatDateTime } from './format';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * #84 session-management dialog for one selected user.
 *
 * Rows come from `GET /admin/sessions?user_id=…` and contain only the session
 * id, client-derived device label and timestamps. The contract has no IP,
 * username, email or token, so this dialog cannot render them. Revoke-all is a
 * two-step action and shows only the server counters on success.
 */
export function AdminSessionsDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const store = useAdminDirectoryStore();
  const { sessions } = useAdminDirectoryState();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const leadId = useId();

  useEffect(() => {
    store.openSessions(user.id);
  }, [store, user.id]);

  useEffect(() => {
    const trigger = document.activeElement;
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
        (element) => !element.hasAttribute('disabled'),
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
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  const busy = sessions.revokeStatus === 'revoking' || sessions.revokeAllStatus === 'revoking';
  const loading = sessions.status === 'loading' && sessions.items.length === 0;
  const forbidden = sessions.error?.status === 403;

  const sessionErrorText = (error: ApiError): string => {
    if (error.status === 403) return t('admin.forbidden.text');
    if (error.status === 404 || error.code === 'USER_NOT_FOUND') {
      return t('admin.sessions.noIdentity');
    }
    if (error.status === 503 || error.code === 'AUTH_UNAVAILABLE') {
      return t('admin.sessions.unavailable');
    }
    if (error.isNetwork) return t('admin.sessions.network');
    return t('admin.sessions.error');
  };

  return (
    <div
      className="notification-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="notification-prefs admin-confirm admin-sessions"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        tabIndex={-1}
      >
        <div className="notification-prefs__head">
          <h2 className="notification-prefs__title" id={titleId}>
            {t('admin.sessions.title')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('admin.actions.close')}
            title={t('admin.actions.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <p className="admin-confirm__lead" id={leadId}>
          {t('admin.sessions.lead', {
            email: user.email ?? user.display_name,
          })}
        </p>

        <div className="admin-sessions__toolbar">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => void store.loadSessions({ force: true })}
            disabled={busy || sessions.status === 'loading'}
          >
            <RefreshIcon aria-hidden="true" />
            {t('admin.refresh')}
          </button>
          <button
            type="button"
            className="button button--danger-ghost button--small"
            onClick={() => setConfirmRevokeAll(true)}
            disabled={busy || sessions.items.length === 0}
          >
            {t('admin.sessions.revokeAll')}
          </button>
        </div>

        {confirmRevokeAll ? (
          <div
            className="admin-sessions__confirm"
            role="group"
            aria-label={t('admin.sessions.confirmTitle')}
          >
            <p className="admin-confirm__lead">{t('admin.sessions.confirmText')}</p>
            <div className="admin-sessions__confirm-actions">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => setConfirmRevokeAll(false)}
                disabled={busy}
              >
                {t('admin.actions.cancel')}
              </button>
              <button
                type="button"
                className="button button--danger button--small"
                onClick={() => {
                  setConfirmRevokeAll(false);
                  void store.revokeAllSessions();
                }}
                disabled={busy}
              >
                {sessions.revokeAllStatus === 'revoking'
                  ? t('admin.sessions.revoking')
                  : t('admin.sessions.confirmAction')}
              </button>
            </div>
          </div>
        ) : null}

        {sessions.revokeAllStatus === 'done' && sessions.revokeAllResult ? (
          <p className="admin-notice admin-notice--ok" role="status" aria-live="polite">
            {t('admin.sessions.revokedAll', {
              count: sessions.revokeAllResult.revoked_sessions,
              users: sessions.revokeAllResult.affected_users,
            })}
          </p>
        ) : null}

        {sessions.revokeAllStatus === 'error' && sessions.revokeAllError ? (
          <div className="admin-state admin-state--error" role="alert">
            <div className="admin-state__body">
              <p>{sessionErrorText(sessions.revokeAllError)}</p>
              <ErrorDetails error={sessions.revokeAllError} />
            </div>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => void store.revokeAllSessions()}
              disabled={busy}
            >
              {t('admin.sessions.retry')}
            </button>
          </div>
        ) : null}

        {sessions.revokeStatus === 'error' && sessions.revokeError ? (
          <div className="admin-state admin-state--error" role="alert">
            <div className="admin-state__body">
              <p>{t('admin.sessions.revokeError')}</p>
              <p className="admin-card__hint">{sessionErrorText(sessions.revokeError)}</p>
              <ErrorDetails error={sessions.revokeError} />
            </div>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => {
                if (sessions.revokeErrorId) void store.revokeSession(sessions.revokeErrorId);
              }}
              disabled={busy || !sessions.revokeErrorId}
            >
              {t('admin.sessions.revokeRetry')}
            </button>
          </div>
        ) : null}

        {loading ? <AdminSkeleton label={t('admin.sessions.loading')} rows={3} /> : null}

        {sessions.status === 'error' && sessions.items.length === 0 ? (
          <AdminErrorState
            text={
              forbidden
                ? t('admin.forbidden.text')
                : sessions.error
                  ? sessionErrorText(sessions.error)
                  : t('admin.sessions.error')
            }
            error={sessions.error}
            retryLabel={t('admin.sessions.retry')}
            onRetry={() => void store.loadSessions({ force: true })}
          />
        ) : null}

        {sessions.status === 'ready' && sessions.items.length === 0 ? (
          <AdminEmptyState
            title={t('admin.sessions.emptyTitle')}
            text={t('admin.sessions.emptyText')}
          />
        ) : null}

        {sessions.items.length > 0 ? (
          <ul className="admin-sessions__list" aria-label={t('admin.sessions.listLabel')}>
            {sessions.items.map((session) => (
              <li className="admin-sessions__row" key={session.id}>
                <div className="admin-sessions__device">
                  <span className="admin-sessions__icon" aria-hidden="true">
                    <ShieldIcon />
                  </span>
                  <span>
                    <b>{session.device || t('admin.sessions.unknownDevice')}</b>
                    <small>
                      {t('admin.sessions.created', {
                        time: formatDateTime(session.created_at),
                      })}
                    </small>
                  </span>
                  {session.current ? (
                    <span className="admin-chip admin-chip--ok">{t('admin.sessions.current')}</span>
                  ) : null}
                </div>
                <div className="admin-sessions__meta">
                  <span>
                    {t('admin.sessions.lastSeen', {
                      time: formatDateTime(session.last_seen_at),
                    })}
                  </span>
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => void store.revokeSession(session.id)}
                    disabled={busy}
                    aria-label={t('admin.sessions.revokeNamed', {
                      device: session.device || t('admin.sessions.unknownDevice'),
                    })}
                  >
                    {sessions.revokeStatus === 'revoking' && sessions.revokingId === session.id
                      ? t('admin.sessions.revoking')
                      : t('admin.sessions.revoke')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {sessions.moreError ? (
          <div className="admin-more">
            <p className="admin-state admin-state--error-inline" role="alert">
              {t('admin.sessions.loadMoreError')}
            </p>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => void store.loadMoreSessions()}
            >
              {t('admin.sessions.retry')}
            </button>
          </div>
        ) : sessions.hasMore ? (
          <div className="admin-more">
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => void store.loadMoreSessions()}
              disabled={sessions.loadingMore}
            >
              {t(sessions.loadingMore ? 'admin.sessions.loadingMore' : 'admin.sessions.loadMore')}
            </button>
          </div>
        ) : null}

        <p className="admin-card__hint">{t('admin.sessions.privacy')}</p>

        <div className="notification-prefs__actions admin-confirm__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {t('admin.actions.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
