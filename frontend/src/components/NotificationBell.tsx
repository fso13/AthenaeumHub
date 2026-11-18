import { useEffect, useId, useRef, useState } from 'react';
import type { Notification } from '../api/types';
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = `${panelId}-title`;

  const unread = state.notifications.unreadCount;
  const label =
    unread > 0 ? t('notifications.openUnread', { count: unread }) : t('notifications.open');

  const closePanel = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const openPanel = () => {
    store.clearNotificationReadError();
    setOpen(true);
    void store.refreshNotifications();
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

  return (
    <div className="notification-center">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button notification-bell"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <BellIcon aria-hidden="true" />
        {unread > 0 ? (
          <span className="notification-bell__badge" aria-hidden="true">
            {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
          </span>
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
              {t('notifications.title')}
            </h2>
            <div className="notification-panel__head-actions">
              <button
                type="button"
                className="notification-panel__action"
                onClick={() => void store.markAllNotificationsRead()}
                disabled={unread === 0 || state.notifications.readAllPending}
              >
                {state.notifications.readAllPending
                  ? t('notifications.markingAll')
                  : t('notifications.markAll')}
              </button>
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

          <NotificationPanelBody
            state={state}
            onOpen={openNotification}
            onRetry={() => void store.refreshNotifications()}
            onLoadMore={() => void store.loadMoreNotifications()}
            onRetryLoadMore={() => void store.loadMoreNotifications()}
          />

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
