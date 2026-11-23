import { useEffect, useId, useState } from 'react';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { formatDateTime } from './admin/format';
import { blockErrorText } from './chat-settings/errors';
import { RefreshIcon } from './Icons';

/**
 * #79 self-service blocks.
 *
 * `GET /me/blocked` intentionally returns only `user_id` + `blocked_at`: there
 * is no display name or email to render. Unblock is a real `DELETE` and the
 * row disappears only after `204`; server failures stay visible.
 */
export interface BlockedUsersCardProps {
  /** #107: render content only; the profile accordion owns the heading. */
  embedded?: boolean;
}

export function BlockedUsersCard({ embedded = false }: BlockedUsersCardProps = {}) {
  const store = useChatStore();
  const state = useChatState();
  const blocked = state.blockedUsers;
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (blocked.status === 'idle') void store.loadBlockedUsers();
  }, [blocked.status, store]);

  const handleUnblock = async (userId: string) => {
    setNotice(null);
    const ok = await store.unblockUser(userId);
    if (ok) setNotice(t('blocked.unblocked'));
  };

  const actionError = blocked.actionError?.error ?? null;

  return (
    <section
      className={embedded ? 'profile-section-body blocked-card' : 'mini-card blocked-card'}
      aria-labelledby={embedded ? undefined : titleId}
    >
      <div className="blocked-card__head">
        {embedded ? null : <h4 id={titleId}>{t('blocked.title')}</h4>}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void store.loadBlockedUsers(true)}
          disabled={blocked.status === 'loading'}
        >
          <RefreshIcon aria-hidden="true" />
          {t('blocked.refreshList')}
        </button>
      </div>

      <p className="mini-card__note">{t('blocked.hint')}</p>

      {notice ? (
        <p className="mini-card__note" role="status">
          {notice}
        </p>
      ) : null}

      {blocked.status === 'loading' && blocked.items.length === 0 ? (
        <p className="mini-card__text" role="status">
          {t('blocked.loading')}
        </p>
      ) : null}

      {blocked.status === 'error' ? (
        <div className="mini-card__error" role="alert">
          <p>{blocked.error ? blockErrorText(blocked.error) : t('blocked.error')}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadBlockedUsers(true)}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {blocked.status === 'ready' && blocked.items.length === 0 ? (
        <p className="mini-card__text">{t('blocked.empty')}</p>
      ) : null}

      {blocked.items.map((item) => {
        const rowError = blocked.actionError?.userId === item.user_id ? actionError : null;
        const pending = blocked.pendingUserId === item.user_id;
        return (
          <div className="blocked-row" key={item.user_id}>
            <div className="blocked-row__body">
              <span className="mini-card__mono">{item.user_id}</span>
              <span className="blocked-row__meta">
                {t('blocked.blockedAt', { date: formatDateTime(item.blocked_at) })}
              </span>
              {rowError ? (
                <span className="blocked-row__error" role="alert">
                  {blockErrorText(rowError)}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled={blocked.pendingUserId !== null}
              aria-label={t('blocked.unblockLabel', { id: item.user_id })}
              onClick={() => void handleUnblock(item.user_id)}
              aria-busy={pending}
            >
              {t('blocked.unblock')}
            </button>
          </div>
        );
      })}
    </section>
  );
}
