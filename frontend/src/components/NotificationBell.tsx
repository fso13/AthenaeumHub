import { useEffect, useId, useRef, useState } from 'react';
import type { Mention, Notification } from '../api/types';
import { formatShortDate } from '../domain/messages';
import { t } from '../i18n/ru';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { BellIcon, CloseIcon, LockIcon, SettingsIcon } from './Icons';
import { NotificationPreferencesDialog } from './NotificationPreferencesDialog';

const BADGE_MAX = 99;

/**
 * Sidebar bell. The panel is a non-modal region: it never traps focus, closes
 * on Escape/outside click and returns focus to the trigger.
 */
export function NotificationBell() {
  const store = useChatStore();
  const state = useChatState();
  const [open, setOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  /** #83: the panel has two server inboxes; mentions are never invented client-side. */
  const [tab, setTab] = useState<'notifications' | 'mentions'>('notifications');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = `${panelId}-title`;

  const mentions = state.mentions;
  // A mention creates both a MENTION notification and an inbox row, so the
  // counters must not be summed. The bell keeps its notification count; the
  // mention inbox has its own tab counter and a secondary dot (visible even
  // when notification preferences muted the MENTION notification).
  const unread = state.notifications.unreadCount;
  const mentionUnread = mentions.unreadCount;
  const label =
    unread > 0 ? t('notifications.openUnread', { count: unread }) : t('notifications.open');

  const closePanel = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const openPanel = () => {
    store.clearNotificationReadError();
    store.clearMentionReadError();
    setOpen(true);
    void store.refreshNotifications();
    void store.refreshMentions();
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const openNotification = async (notification: Notification) => {
    if (!notification.read) await store.markNotificationRead(notification.id);
    if (notification.chat_id && state.slices[notification.chat_id]) {
      await store.setActiveChat(notification.chat_id);
    }
    closePanel();
  };

  const openMention = async (mention: Mention) => {
    if (mention.read_at === null) await store.markMentionRead(mention.id);
    if (state.slices[mention.chat_id]) {
      await store.setActiveChat(mention.chat_id);
    }
    closePanel();
  };

  return (
    <div className="notification-center">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button notification-bell"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={mentionUnread > 0 ? t('mentions.inbox.badge', { count: mentionUnread }) : undefined}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <BellIcon aria-hidden="true" />
        {unread > 0 ? (
          <span className="notification-bell__badge" aria-hidden="true">
            {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
          </span>
        ) : null}
        {mentionUnread > 0 ? (
          <span className="notification-bell__mention-dot" aria-hidden="true" />
        ) : null}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {unread > 0 ? t('notifications.unreadAnnounce', { count: unread }) : ''}
      </span>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="notification-panel"
          role="region"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="notification-panel__head">
            <h2 className="notification-panel__title" id={titleId}>
              {tab === 'mentions' ? t('mentions.inbox.title') : t('notifications.title')}
            </h2>
            <div className="notification-panel__head-actions">
              {tab === 'mentions' ? (
                <button
                  type="button"
                  className="notification-panel__action"
                  onClick={() => void store.markAllMentionsRead()}
                  disabled={mentions.unreadCount === 0 || mentions.readAllPending}
                >
                  {mentions.readAllPending
                    ? t('mentions.inbox.markingAll')
                    : t('mentions.inbox.markAll')}
                </button>
              ) : (
                <button
                  type="button"
                  className="notification-panel__action"
                  onClick={() => void store.markAllNotificationsRead()}
                  disabled={
                    state.notifications.unreadCount === 0 || state.notifications.readAllPending
                  }
                >
                  {state.notifications.readAllPending
                    ? t('notifications.markingAll')
                    : t('notifications.markAll')}
                </button>
              )}
              <button
                type="button"
                className="icon-button notification-panel__close"
                onClick={closePanel}
                aria-label={t('notifications.close')}
                title={t('notifications.close')}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            className="notification-panel__tabs"
            role="tablist"
            aria-label={t('mentions.inbox.title')}
          >
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-notifications`}
              aria-selected={tab === 'notifications'}
              aria-controls={`${panelId}-tabpanel`}
              className={`notification-panel__tab${tab === 'notifications' ? ' is-active' : ''}`}
              onClick={() => setTab('notifications')}
            >
              {t('mentions.inbox.tabNotifications')}
              {state.notifications.unreadCount > 0 ? (
                <span className="notification-panel__tab-count">
                  {state.notifications.unreadCount > BADGE_MAX
                    ? `${BADGE_MAX}+`
                    : state.notifications.unreadCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-mentions`}
              aria-selected={tab === 'mentions'}
              aria-controls={`${panelId}-tabpanel`}
              className={`notification-panel__tab${tab === 'mentions' ? ' is-active' : ''}`}
              onClick={() => {
                setTab('mentions');
                if (mentions.status === 'idle') void store.refreshMentions();
              }}
            >
              {t('mentions.inbox.tabMentions')}
              {mentions.unreadCount > 0 ? (
                <span className="notification-panel__tab-count">
                  {mentions.unreadCount > BADGE_MAX ? `${BADGE_MAX}+` : mentions.unreadCount}
                </span>
              ) : null}
            </button>
          </div>

          <div
            id={`${panelId}-tabpanel`}
            className="notification-panel__tabpanel"
            role="tabpanel"
            aria-labelledby={`${panelId}-tab-${tab}`}
          >
            {tab === 'mentions' ? (
              <MentionPanelBody
                state={state}
                onOpen={openMention}
                onRetry={() => void store.refreshMentions()}
                onLoadMore={() => void store.loadMoreMentions()}
                onToggleUnread={() => void store.setMentionsUnreadOnly(!mentions.unreadOnly)}
                onMarkRead={(id) => void store.markMentionRead(id)}
              />
            ) : (
              <NotificationPanelBody
                state={state}
                onOpen={openNotification}
                onRetry={() => void store.refreshNotifications()}
                onLoadMore={() => void store.loadMoreNotifications()}
                onRetryLoadMore={() => void store.loadMoreNotifications()}
              />
            )}
          </div>

          <div className="notification-panel__foot">
            <button
              type="button"
              className="notification-panel__settings"
              onClick={() => {
                setOpen(false);
                setPreferencesOpen(true);
              }}
            >
              <SettingsIcon aria-hidden="true" />
              {t('notifications.preferences.open')}
            </button>
          </div>
        </div>
      ) : null}

      <NotificationPreferencesDialog
        open={preferencesOpen}
        onClose={() => {
          setPreferencesOpen(false);
          buttonRef.current?.focus();
        }}
      />
    </div>
  );
}

function NotificationPanelBody({
  state,
  onOpen,
  onRetry,
  onLoadMore,
  onRetryLoadMore,
}: {
  state: ReturnType<typeof useChatState>;
  onOpen: (notification: Notification) => Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
  onRetryLoadMore: () => void;
}) {
  const notifications = state.notifications;
  const hasItems = notifications.items.length > 0;
  const loading = notifications.status === 'loading' && !hasItems;

  if (loading || notifications.status === 'idle') {
    return (
      <div className="notification-panel__state" role="status" aria-busy="true">
        {t('notifications.loading')}
      </div>
    );
  }

  if (notifications.status === 'error' && !hasItems) {
    return (
      <div className="notification-panel__state notification-panel__state--error" role="alert">
        <strong>{t('notifications.errorTitle')}</strong>
        <span>{t('notifications.errorText')}</span>
        <button type="button" className="button button--primary" onClick={onRetry}>
          {t('notifications.retry')}
        </button>
      </div>
    );
  }

  if (!hasItems) {
    return (
      <div className="notification-panel__state">
        <strong>{t('notifications.emptyTitle')}</strong>
        <span>{t('notifications.emptyText')}</span>
      </div>
    );
  }

  const readError = notifications.readError;
  const readErrorText =
    readError?.status === 403 || readError?.status === 404
      ? t('notifications.preferences.forbidden')
      : readError
        ? t('notifications.readError')
        : null;

  return (
    <>
      {notifications.error ? (
        <div className="notification-panel__notice" role="alert">
          <span>{t('notifications.errorText')}</span>
          <button type="button" className="notification-panel__link" onClick={onRetry}>
            {t('notifications.retry')}
          </button>
        </div>
      ) : null}
      {readErrorText ? (
        <div className="notification-panel__notice notification-panel__notice--error" role="alert">
          {notifications.readAllPending ? t('notifications.readAllError') : readErrorText}
        </div>
      ) : null}

      <ul className="notification-list" aria-label={t('notifications.title')}>
        {notifications.items.map((notification) => (
          <li key={notification.id}>
            <button
              type="button"
              className={`notification-item${notification.read ? '' : ' notification-item--unread'}`}
              onClick={() => void onOpen(notification)}
            >
              <span className="notification-item__main">
                <span className="notification-item__title-row">
                  <span className="notification-item__title">{notification.title}</span>
                  <time className="notification-item__time" dateTime={notification.created_at}>
                    {formatShortDate(notification.created_at)}
                  </time>
                </span>
                <span className="notification-item__meta">
                  {notification.chat_name ? (
                    <span className="notification-item__chat">{notification.chat_name}</span>
                  ) : (
                    <span className="notification-item__chat">{t('notifications.noChat')}</span>
                  )}
                  <span className="notification-item__type">
                    {t(`notifications.type.${notification.type}`)}
                  </span>
                </span>
                {notification.body ? (
                  <span className="notification-item__body">{notification.body}</span>
                ) : (
                  <span className="notification-item__hidden">
                    <LockIcon aria-hidden="true" />
                    {t('notifications.hiddenBody')}
                  </span>
                )}
              </span>
              <span
                className={`notification-item__state${notification.read ? '' : ' notification-item__state--unread'}`}
              >
                {notification.read ? t('notifications.read') : t('notifications.unread')}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {notifications.hasMore || notifications.loadMoreStatus === 'error' ? (
        <div className="notification-panel__more">
          {notifications.loadMoreStatus === 'error' ? (
            <span className="notification-panel__more-error">
              {t('notifications.loadMoreError')}
            </span>
          ) : null}
          <button
            type="button"
            className="notification-panel__link"
            onClick={notifications.loadMoreStatus === 'error' ? onRetryLoadMore : onLoadMore}
            disabled={notifications.loadMoreStatus === 'loading'}
          >
            {notifications.loadMoreStatus === 'loading'
              ? t('notifications.loadingMore')
              : t('notifications.loadMore')}
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * #83: `/me/mentions` inbox. Rows are content-free by contract (chat, author,
 * time, read state), so no message text is ever rendered here.
 */
function MentionPanelBody({
  state,
  onOpen,
  onRetry,
  onLoadMore,
  onToggleUnread,
  onMarkRead,
}: {
  state: ReturnType<typeof useChatState>;
  onOpen: (mention: Mention) => Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
  onToggleUnread: () => void;
  onMarkRead: (id: string) => void;
}) {
  const mentions = state.mentions;
  const hasItems = mentions.items.length > 0;
  const loading = mentions.status === 'loading' && !hasItems;

  const controls = (
    <label className="notification-panel__filter">
      <input
        type="checkbox"
        checked={mentions.unreadOnly}
        onChange={onToggleUnread}
        disabled={mentions.status === 'loading'}
      />
      <span>{t('mentions.inbox.unreadOnly')}</span>
    </label>
  );

  if (loading || mentions.status === 'idle') {
    return (
      <div className="notification-panel__state" role="status" aria-busy="true">
        {t('mentions.inbox.loading')}
      </div>
    );
  }

  if (mentions.status === 'error' && !hasItems) {
    return (
      <div className="notification-panel__state notification-panel__state--error" role="alert">
        <strong>{t('mentions.inbox.errorTitle')}</strong>
        <span>{t('mentions.inbox.errorText')}</span>
        <button type="button" className="button button--primary" onClick={onRetry}>
          {t('mentions.inbox.retry')}
        </button>
      </div>
    );
  }

  const readErrorText = mentions.readError ? t('mentions.inbox.readError') : null;

  return (
    <>
      {controls}
      {mentions.error ? (
        <div className="notification-panel__notice" role="alert">
          <span>{t('mentions.inbox.errorText')}</span>
          <button type="button" className="notification-panel__link" onClick={onRetry}>
            {t('mentions.inbox.retry')}
          </button>
        </div>
      ) : null}
      {readErrorText ? (
        <div className="notification-panel__notice notification-panel__notice--error" role="alert">
          {readErrorText}
        </div>
      ) : null}

      {!hasItems ? (
        <div className="notification-panel__state">
          <strong>{t('mentions.inbox.emptyTitle')}</strong>
          <span>{t('mentions.inbox.emptyText')}</span>
        </div>
      ) : (
        <ul className="notification-list" aria-label={t('mentions.inbox.title')}>
          {mentions.items.map((mention) => {
            const unread = mention.read_at === null;
            const pending = mentions.readPendingIds.includes(mention.id);
            return (
              <li key={mention.id}>
                <button
                  type="button"
                  className={`notification-item${unread ? ' notification-item--unread' : ''}`}
                  onClick={() => void onOpen(mention)}
                >
                  <span className="notification-item__main">
                    <span className="notification-item__title-row">
                      <span className="notification-item__title">
                        {mention.mention_all
                          ? t('mentions.inbox.mentionAll')
                          : t('mentions.inbox.mentionedYou')}
                      </span>
                      <time className="notification-item__time" dateTime={mention.created_at}>
                        {formatShortDate(mention.created_at)}
                      </time>
                    </span>
                    <span className="notification-item__meta">
                      <span className="notification-item__chat">
                        {mention.chat_name ?? t('mentions.inbox.noChat')}
                      </span>
                      {mention.sender_display_name ? (
                        <span className="notification-item__type">
                          {mention.sender_display_name}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span
                    className={`notification-item__state${
                      unread ? ' notification-item__state--unread' : ''
                    }`}
                  >
                    {unread ? t('mentions.inbox.unread') : t('mentions.inbox.read')}
                  </span>
                </button>
                {unread ? (
                  <button
                    type="button"
                    className="notification-panel__link notification-item__mark-read"
                    onClick={() => onMarkRead(mention.id)}
                    disabled={pending}
                  >
                    {pending ? t('notifications.markingAll') : t('mentions.inbox.markRead')}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {mentions.hasMore || mentions.loadMoreStatus === 'error' ? (
        <div className="notification-panel__more">
          {mentions.loadMoreStatus === 'error' ? (
            <span className="notification-panel__more-error">
              {t('mentions.inbox.loadMoreError')}
            </span>
          ) : null}
          <button
            type="button"
            className="notification-panel__link"
            onClick={onLoadMore}
            disabled={mentions.loadMoreStatus === 'loading'}
          >
            {mentions.loadMoreStatus === 'loading'
              ? t('mentions.inbox.loadingMore')
              : t('mentions.inbox.loadMore')}
          </button>
        </div>
      ) : null}
    </>
  );
}
