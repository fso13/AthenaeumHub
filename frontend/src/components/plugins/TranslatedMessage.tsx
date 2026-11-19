import type { MessageKey } from '../../i18n/ru';
import { t } from '../../i18n/ru';
import { pluginActionErrorText } from '../../plugins/errors';
import { usePluginGate } from '../../plugins/gate';
import { usePluginActionsState, usePluginActionsStore } from '../../store/ChatProvider';
import { CloseIcon, TranslateIcon } from '../Icons';

const LANGUAGE_LABEL: Record<string, MessageKey> = {
  ru: 'pluginActions.langRu',
  en: 'pluginActions.langEn',
};

function languageLabel(target: string): string {
  const key = LANGUAGE_LABEL[target];
  return key ? t(key) : target;
}

interface TranslatedMessageProps {
  chatId: string;
  messageId: string;
}

/**
 * D1.1 (#76) inline translation block. It renders only after the user asked for
 * a translation, only while the `translate` plugin is server-enabled, and only
 * with the text returned by the API. `503 TRANSLATION_UNAVAILABLE` stays an
 * honest error with a retry — never a client-side fallback translation.
 */
export function TranslatedMessage({ chatId, messageId }: TranslatedMessageProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const gate = usePluginGate(chatId, false);
  const entry =
    state.chatId === chatId ? (state.translations[`${chatId}:${messageId}`] ?? null) : null;

  if (entry === null) return null;
  if (gate.ready && !gate.enabled('translate')) return null;

  return (
    <div className="msg-translation" aria-live="polite">
      <div className="msg-translation__head">
        <TranslateIcon aria-hidden="true" />
        <span className="msg-translation__label">
          {t('pluginActions.translationTitle', { language: languageLabel(entry.target) })}
        </span>
        <button
          type="button"
          className="msg-translation__hide"
          onClick={() => store.clearTranslation(chatId, messageId)}
          aria-label={t('pluginActions.hideTranslation')}
          title={t('pluginActions.hideTranslation')}
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </div>

      {entry.status === 'loading' ? (
        <p className="msg-translation__state" role="status">
          {t('pluginActions.translating')}
        </p>
      ) : entry.status === 'error' && entry.error ? (
        <div className="msg-translation__error" role="alert">
          <p>{pluginActionErrorText(entry.error, 'translation')}</p>
          <button
            type="button"
            className="button button--small"
            onClick={() => void store.retryTranslation(chatId, messageId)}
          >
            {t('pluginActions.translateRetry')}
          </button>
        </div>
      ) : (
        <p className="msg-translation__text">{entry.text}</p>
      )}
    </div>
  );
}
