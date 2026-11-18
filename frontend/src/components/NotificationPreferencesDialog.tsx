import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../api/problem';
import type {
  NotificationChannel,
  NotificationMode,
  NotificationPreference,
  NotificationPreferencePatch,
  NotificationType,
} from '../api/types';
import { describeError } from '../domain/errors';
import { t, type MessageKey } from '../i18n/ru';
import { notificationPreferenceKey } from '../store/chatStore';
import { useChatState, useChatStore } from '../store/ChatProvider';
import { CloseIcon } from './Icons';

const NOTIFICATION_TYPES: NotificationType[] = ['MESSAGE', 'MENTION', 'SYSTEM'];
const CHANNELS: NotificationChannel[] = ['IN_APP', 'EMAIL'];
const MODES: NotificationMode[] = ['ALL', 'MENTIONS', 'MUTE'];

const TYPE_LABEL: Record<NotificationType, MessageKey> = {
  MESSAGE: 'notifications.preferences.type.MESSAGE',
  MENTION: 'notifications.preferences.type.MENTION',
  SYSTEM: 'notifications.preferences.type.SYSTEM',
};

const CHANNEL_LABEL: Record<NotificationChannel, MessageKey> = {
  IN_APP: 'notifications.preferences.channel.IN_APP',
  EMAIL: 'notifications.preferences.channel.EMAIL',
};

const MODE_LABEL: Record<NotificationMode, MessageKey> = {
  ALL: 'notifications.preferences.mode.ALL',
  MENTIONS: 'notifications.preferences.mode.MENTIONS',
  MUTE: 'notifications.preferences.mode.MUTE',
};

const MODE_LIST_LABEL: Record<NotificationMode, MessageKey> = {
  ALL: 'notifications.preferences.modeLabel.ALL',
  MENTIONS: 'notifications.preferences.modeLabel.MENTIONS',
  MUTE: 'notifications.preferences.modeLabel.MUTE',
};

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface NotificationPreferencesDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * E6-F notification preferences.
 *
 * One contract operation (`PATCH /notification-preferences`) upserts a row by
 * `(chat_id, type, channel)`; the dialog therefore offers an editor plus the
 * server-returned list instead of inventing per-chat create/delete endpoints.
 */
export function NotificationPreferencesDialog({
  open,
  onClose,
}: NotificationPreferencesDialogProps) {
  const store = useChatStore();
  const state = useChatState();
  const [scope, setScope] = useState('global');
  const [type, setType] = useState<NotificationType>('MESSAGE');
  const [channel, setChannel] = useState<NotificationChannel>('IN_APP');
  const [mode, setMode] = useState<NotificationMode>('ALL');
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const scopeId = useId();
  const typeId = useId();
  const channelId = useId();
  const modeId = useId();

  const preferences = state.notificationPreferences;

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setLocalError(null);
    void store.loadNotificationPreferences({ force: true });
    dialogRef.current?.focus();
  }, [open, store]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
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
  }, [onClose, open]);

  if (!open) return null;

  const resetFeedback = () => {
    setSaved(false);
    setLocalError(null);
    store.clearPreferenceSaveError();
  };

  const handleEdit = (preference: NotificationPreference) => {
    setScope(preference.chat_id ?? 'global');
    setType(preference.type);
    setChannel(preference.channel);
    setMode(preference.mode);
    resetFeedback();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    setLocalError(null);

    if (scope !== 'global' && !state.chats.some((chat) => chat.id === scope)) {
      setLocalError(t('notifications.preferences.validation'));
      return;
    }

    const patch: NotificationPreferencePatch = {
      type,
      channel,
      mode,
      ...(scope === 'global' ? {} : { chat_id: scope }),
    };
    const updated = await store.saveNotificationPreference(patch);
    if (updated) setSaved(true);
  };

  const saveError = preferences.saveError;
  const sortedPreferences = [...preferences.items].sort((left, right) => {
    const chatCompare = (left.chat_id ?? '').localeCompare(right.chat_id ?? '');
    if (chatCompare !== 0) return chatCompare;
    const typeCompare = left.type.localeCompare(right.type);
    if (typeCompare !== 0) return typeCompare;
    return left.channel.localeCompare(right.channel);
  });

  const chatName = (chatId: string | null): string => {
    if (!chatId) return t('notifications.preferences.scopeGlobal');
    return (
      state.chats.find((chat) => chat.id === chatId)?.name ??
      t('notifications.preferences.chatFallback', { id: chatId.slice(0, 8) })
    );
  };

  return (
    <div
      className="notification-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="notification-prefs"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="notification-prefs__head">
          <h2 className="notification-prefs__title" id={titleId}>
            {t('notifications.preferences.title')}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('notifications.preferences.close')}
            title={t('notifications.preferences.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>

        <p className="notification-prefs__lead">{t('notifications.preferences.lead')}</p>

        {preferences.status === 'loading' && preferences.items.length === 0 ? (
          <p className="notification-prefs__state" role="status" aria-busy="true">
            {t('notifications.preferences.loading')}
          </p>
        ) : null}

        {preferences.status === 'error' ? (
          <div
            className="notification-prefs__notice notification-prefs__notice--error"
            role="alert"
          >
            <span>{t('notifications.preferences.errorTitle')}</span>
            <button
              type="button"
              className="notification-panel__link"
              onClick={() => void store.loadNotificationPreferences({ force: true })}
            >
              {t('notifications.retry')}
            </button>
          </div>
        ) : null}

        <form className="notification-prefs__form" onSubmit={(event) => void handleSubmit(event)}>
          <h3 className="notification-prefs__section">
            {t('notifications.preferences.formSection')}
          </h3>
          <div className="notification-prefs__grid">
            <label className="notification-prefs__field" htmlFor={scopeId}>
              <span>{t('notifications.preferences.scope')}</span>
              <select
                id={scopeId}
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  resetFeedback();
                }}
              >
                <option value="global">{t('notifications.preferences.scopeGlobal')}</option>
                {state.chats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="notification-prefs__field" htmlFor={typeId}>
              <span>{t('notifications.preferences.type')}</span>
              <select
                id={typeId}
                value={type}
                onChange={(event) => {
                  setType(event.target.value as NotificationType);
                  resetFeedback();
                }}
              >
                {NOTIFICATION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(TYPE_LABEL[value])}
                  </option>
                ))}
              </select>
            </label>

            <label className="notification-prefs__field" htmlFor={channelId}>
              <span>{t('notifications.preferences.channel')}</span>
              <select
                id={channelId}
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as NotificationChannel);
                  resetFeedback();
                }}
              >
                {CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {t(CHANNEL_LABEL[value])}
                  </option>
                ))}
              </select>
            </label>

            <label className="notification-prefs__field" htmlFor={modeId}>
              <span>{t('notifications.preferences.mode')}</span>
              <select
                id={modeId}
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as NotificationMode);
                  resetFeedback();
                }}
              >
                {MODES.map((value) => (
                  <option key={value} value={value}>
                    {t(MODE_LABEL[value])}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {channel === 'EMAIL' ? (
            <p className="notification-prefs__hint">{t('notifications.preferences.emailHint')}</p>
          ) : null}

          {!state.online ? (
            <p className="notification-prefs__hint">{t('notifications.preferences.offline')}</p>
          ) : null}

          {localError ? (
            <p
              className="notification-prefs__notice notification-prefs__notice--error"
              role="alert"
            >
              {localError}
            </p>
          ) : null}

          {saveError ? (
            <p
              className="notification-prefs__notice notification-prefs__notice--error"
              role="alert"
            >
              {preferenceErrorText(saveError)}
            </p>
          ) : null}

          <div className="notification-prefs__actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={preferences.saving || !state.online}
            >
              {preferences.saving
                ? t('notifications.preferences.saving')
                : t('notifications.preferences.save')}
            </button>
            {saved ? (
              <span className="notification-prefs__saved" role="status">
                {t('notifications.preferences.saved')}
              </span>
            ) : null}
          </div>
        </form>

        <section className="notification-prefs__list" aria-labelledby={`${titleId}-list`}>
          <h3 className="notification-prefs__section" id={`${titleId}-list`}>
            {t('notifications.preferences.listSection')}
          </h3>
          {preferences.items.length === 0 ? (
            <p className="notification-prefs__state">{t('notifications.preferences.empty')}</p>
          ) : (
            <ul className="notification-prefs__rows">
              {sortedPreferences.map((preference) => (
                <li className="notification-prefs__row" key={notificationPreferenceKey(preference)}>
                  <span className="notification-prefs__row-main">
                    <span className="notification-prefs__row-title">
                      {t(TYPE_LABEL[preference.type])} · {t(CHANNEL_LABEL[preference.channel])}
                    </span>
                    <span className="notification-prefs__row-chat">
                      {chatName(preference.chat_id ?? null)}
                    </span>
                  </span>
                  <span
                    className={`notification-prefs__mode notification-prefs__mode--${preference.mode}`}
                  >
                    {t(MODE_LIST_LABEL[preference.mode])}
                  </span>
                  <button
                    type="button"
                    className="notification-panel__link"
                    onClick={() => handleEdit(preference)}
                  >
                    {t('notifications.preferences.edit')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function preferenceErrorText(error: ApiError): string {
  if (error.status === 422) return t('notifications.preferences.validation');
  if (error.status === 403 || error.status === 404) {
    return t('notifications.preferences.forbidden');
  }
  return describeError(error).message;
}
