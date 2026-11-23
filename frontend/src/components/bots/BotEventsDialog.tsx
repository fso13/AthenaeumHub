import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiError } from '../../api/problem';
import type {
  Bot,
  BotCommand,
  BotDelivery,
  BotDeliveryStatus,
  BotEventType,
} from '../../api/types';
import { botEventErrorText } from '../../bots/errors';
import { isValidCommandName } from '../../bots/commands';
import { t, type MessageKey } from '../../i18n/ru';
import { useBotsState, useBotsStore } from '../../store/ChatProvider';
import { formatDateTime } from '../admin/format';
import { CloseIcon, CopyIcon, PlusIcon, RefreshIcon, TrashIcon } from '../Icons';

const EVENT_TYPES = ['message.created', 'app_mention'] as const;
const MAX_COMMANDS = 50;
const MAX_COMMAND_DESCRIPTION = 256;

const DELIVERY_STATUS_LABEL: Record<BotDeliveryStatus, MessageKey> = {
  PENDING: 'bots.events.status.PENDING',
  DELIVERED: 'bots.events.status.DELIVERED',
  FAILED: 'bots.events.status.FAILED',
};

const DELIVERY_TYPE_LABEL: Record<BotEventType, MessageKey> = {
  'message.created': 'bots.events.type.message.created',
  app_mention: 'bots.events.type.app_mention',
  slash_command: 'bots.events.type.slash_command',
  test: 'bots.events.type.test',
};

/**
 * #98 event settings for one bot.
 *
 * - The events URL is https-only; an empty value clears the webhook and the
 *   copy explains that slash commands need an active URL + signing secret.
 * - Commands are edited as a local draft and saved as a full replacement.
 * - The signing secret is a one-time response: it is rendered from the store,
 *   copied on explicit user action and cleared when this dialog closes. It is
 *   never written to storage or included in the deliveries view.
 * - Deliveries are content-free statuses (`PENDING`/`DELIVERED`/`FAILED`); the
 *   test-event action only queues a signed ping (`202`).
 */
export interface BotEventsDialogProps {
  workspaceId: string;
  bot: Bot;
  onClose: () => void;
}

export function isHttpsEventUrl(value: string): boolean {
  const raw = value.trim();
  if (raw.length < 9 || raw.length > 2048 || raw !== value) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function eventTypeLabel(type: BotEventType): string {
  return t(DELIVERY_TYPE_LABEL[type]);
}

function deliveryErrorText(error: ApiError): string {
  return botEventErrorText(error);
}

export function BotEventsDialog({ workspaceId, bot, onClose }: BotEventsDialogProps) {
  const store = useBotsStore();
  const state = useBotsState();
  const workspace = state.workspace;
  const row = workspace.items.find((item) => item.id === bot.id) ?? bot;

  const titleId = useId();
  const leadId = useId();
  const urlId = useId();
  const urlHintId = useId();
  const eventsId = useId();
  const commandsTitleId = useId();
  const commandNameId = useId();
  const commandDescriptionId = useId();
  const commandHintId = useId();
  const secretId = useId();
  const secretHintId = useId();
  const deliveriesTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [eventsUrl, setEventsUrl] = useState(row.events_url ?? '');
  const [events, setEvents] = useState<string[]>(row.events ?? []);
  const [eventsEnabled, setEventsEnabled] = useState(row.events_enabled ?? false);
  const [commands, setCommands] = useState<BotCommand[]>(row.commands ?? []);
  const [commandName, setCommandName] = useState('');
  const [commandDescription, setCommandDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secretConfirm, setSecretConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const saving = workspace.eventsSavingId === bot.id;
  const secretPending = workspace.secretPendingId === bot.id;
  const testPending = workspace.testPendingId === bot.id;
  const eventsError = workspace.eventsError?.botId === bot.id ? workspace.eventsError.error : null;
  const secretError = workspace.secretError?.botId === bot.id ? workspace.secretError.error : null;
  const testError = workspace.testError?.botId === bot.id ? workspace.testError.error : null;
  const secret = workspace.signingSecret?.botId === bot.id ? workspace.signingSecret : null;
  const deliveries = workspace.deliveries?.botId === bot.id ? workspace.deliveries : null;
  const testAccepted = workspace.testAccepted?.botId === bot.id ? workspace.testAccepted : null;

  // Server truth seeds the draft; `updated_at` changes only on a save.
  useEffect(() => {
    setEventsUrl(row.events_url ?? '');
    setEvents(row.events ?? []);
    setEventsEnabled(row.events_enabled ?? false);
    setCommands(row.commands ?? []);
    setCommandName('');
    setCommandDescription('');
    setFormError(null);
    setCommandError(null);
    setSecretConfirm(false);
  }, [bot.id, row.updated_at, row.events_url, row.events, row.events_enabled, row.commands]);

  useEffect(() => {
    void store.loadBotDeliveries(workspaceId, bot.id, 20, true);
  }, [bot.id, store, workspaceId]);

  // Closing the dialog must drop the one-time secret and transient notices.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    urlRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      store.clearBotEventFeedback();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [store]);

  const toggleEvent = (type: (typeof EVENT_TYPES)[number]) => {
    setNotice(null);
    setFormError(null);
    setEvents((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  const addCommand = () => {
    setNotice(null);
    setCommandError(null);
    const name = commandName.trim().toLowerCase();
    const description = commandDescription.trim();
    if (!isValidCommandName(name)) {
      setCommandError(t('bots.events.commandInvalid'));
      return;
    }
    if (commands.some((entry) => entry.command === name)) {
      setCommandError(t('bots.events.commandDuplicate'));
      return;
    }
    if (description.length < 1 || description.length > MAX_COMMAND_DESCRIPTION) {
      setCommandError(t('bots.events.commandDescriptionRequired'));
      return;
    }
    if (commands.length >= MAX_COMMANDS) {
      setCommandError(t('bots.events.commandLimit'));
      return;
    }
    setCommands([...commands, { command: name, description }]);
    setCommandName('');
    setCommandDescription('');
  };

  const removeCommand = (name: string) => {
    setNotice(null);
    setCommands(commands.filter((entry) => entry.command !== name));
  };

  const save = async () => {
    setFormError(null);
    setNotice(null);
    const url = eventsUrl.trim();
    if (url !== '' && !isHttpsEventUrl(url)) {
      setFormError(t('bots.events.urlInvalid'));
      return;
    }
    if ((eventsEnabled || events.length > 0) && url === '') {
      setFormError(t('bots.events.urlRequired'));
      return;
    }
    const saved = await store.saveBotEvents(workspaceId, bot.id, {
      events_url: url,
      events: events as Array<'message.created' | 'app_mention'>,
      events_enabled: url === '' ? false : eventsEnabled,
      commands,
    });
    if (saved) {
      setNotice(t('bots.events.saved'));
      setSecretConfirm(false);
    }
  };

  const rotateSecret = async () => {
    setSecretConfirm(false);
    setNotice(null);
    const issued = await store.rotateSigningSecret(workspaceId, bot.id);
    if (issued) setCopied(false);
  };

  const copySecret = async () => {
    if (!secret) return;
    setCopyError(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(secret.secret);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  const deliveryRows = deliveries?.items ?? [];
  const loadingDeliveries = deliveries === null || deliveries.status === 'loading';

  return createPortal(
    <div className="modal-layer">
      <div
        className="modal modal--lg bot-events-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {t('bots.events.title')}
          </h2>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body bot-events">
          <p className="bot-events__lead" id={leadId}>
            {t('bots.events.lead', { name: row.name })}
          </p>

          {notice ? (
            <p className="chat-settings-notice" role="status">
              {notice}
            </p>
          ) : null}
          {eventsError ? (
            <p className="chat-settings-error" role="alert">
              {deliveryErrorText(eventsError)}
            </p>
          ) : null}

          <section className="bot-events__section" aria-labelledby={`${eventsId}-title`}>
            <h3 className="bot-events__title" id={`${eventsId}-title`}>
              {t('bots.events.webhookTitle')}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor={urlId}>
                {t('bots.events.urlLabel')}
              </label>
              <input
                id={urlId}
                ref={urlRef}
                className="field__input"
                type="url"
                inputMode="url"
                value={eventsUrl}
                maxLength={2048}
                placeholder={t('bots.events.urlPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                disabled={saving}
                aria-invalid={formError !== null}
                aria-describedby={`${urlHintId} ${eventsId}-hint`}
                onChange={(event) => {
                  setEventsUrl(event.target.value);
                  if (formError) setFormError(null);
                  setNotice(null);
                }}
              />
              <p className="field__meta" id={urlHintId}>
                {t('bots.events.urlHint')}
              </p>
            </div>

            <fieldset className="bot-events__fieldset" aria-describedby={`${eventsId}-hint`}>
              <legend className="bot-events__legend">{t('bots.events.subscriptions')}</legend>
              {EVENT_TYPES.map((type) => (
                <label className="bot-events__check" key={type}>
                  <input
                    type="checkbox"
                    checked={events.includes(type)}
                    disabled={saving}
                    onChange={() => toggleEvent(type)}
                  />
                  {t(
                    type === 'message.created'
                      ? 'bots.events.messageCreated'
                      : 'bots.events.appMention',
                  )}
                </label>
              ))}
            </fieldset>

            <label className="bot-events__check">
              <input
                type="checkbox"
                checked={eventsEnabled}
                disabled={saving}
                onChange={(event) => {
                  setEventsEnabled(event.target.checked);
                  setNotice(null);
                }}
              />
              {t('bots.events.enabledLabel')}
            </label>
            <p className="field__meta" id={`${eventsId}-hint`}>
              {t('bots.events.enabledHint')} {t('bots.events.eventsHint')}
            </p>

            {formError ? (
              <p className="chat-settings-error" role="alert">
                {formError}
              </p>
            ) : null}
          </section>

          <section className="bot-events__section" aria-labelledby={commandsTitleId}>
            <h3 className="bot-events__title" id={commandsTitleId}>
              {t('bots.events.commandsTitle')}
            </h3>
            <p className="field__meta">{t('bots.events.commandsHint')}</p>
            {commands.length === 0 ? (
              <p className="card-empty">{t('bots.events.commandsEmpty')}</p>
            ) : (
              <ul className="bot-command-list" aria-label={t('bots.events.commandsTitle')}>
                {commands.map((entry) => (
                  <li className="bot-command-row" key={entry.command}>
                    <span className="bot-command-row__name">/{entry.command}</span>
                    <span className="bot-command-row__description">{entry.description}</span>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={saving}
                      aria-label={t('bots.events.removeCommand', { command: entry.command })}
                      onClick={() => removeCommand(entry.command)}
                    >
                      <TrashIcon aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="bot-command-add">
              <div className="field">
                <label className="field__label" htmlFor={commandNameId}>
                  {t('bots.events.commandName')}
                </label>
                <input
                  id={commandNameId}
                  className="field__input"
                  value={commandName}
                  maxLength={32}
                  placeholder="echo"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  aria-describedby={commandHintId}
                  onChange={(event) => {
                    setCommandName(event.target.value.toLowerCase());
                    if (commandError) setCommandError(null);
                  }}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={commandDescriptionId}>
                  {t('bots.events.commandDescription')}
                </label>
                <input
                  id={commandDescriptionId}
                  className="field__input"
                  value={commandDescription}
                  maxLength={MAX_COMMAND_DESCRIPTION}
                  placeholder={t('bots.events.commandDescription')}
                  autoComplete="off"
                  disabled={saving}
                  onChange={(event) => {
                    setCommandDescription(event.target.value);
                    if (commandError) setCommandError(null);
                  }}
                />
              </div>
              <button type="button" className="btn btn--sm" disabled={saving} onClick={addCommand}>
                <PlusIcon aria-hidden="true" />
                {t('bots.events.addCommand')}
              </button>
            </div>
            <p className="field__meta" id={commandHintId}>
              {commandError ?? t('bots.events.commandsHint')}
            </p>
          </section>

          <section className="bot-events__section" aria-labelledby={`${secretId}-title`}>
            <h3 className="bot-events__title" id={`${secretId}-title`}>
              {t('bots.events.secretHeading')}
            </h3>
            <p className="field__meta">{t('bots.events.secretHint')}</p>

            {secret ? (
              <div className="bot-secret" role="status">
                <p className="bot-token__warning">{t('bots.events.secretOnceLead')}</p>
                <div className="bot-token__row">
                  <label className="visually-hidden" htmlFor={secretId}>
                    {t('bots.events.secretLabel')}
                  </label>
                  <input
                    id={secretId}
                    className="input bot-token__value"
                    readOnly
                    value={secret.secret}
                    spellCheck={false}
                    autoComplete="off"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button type="button" className="btn btn--sm" onClick={() => void copySecret()}>
                    <CopyIcon aria-hidden="true" />
                    {copied ? t('bots.events.secretCopied') : t('bots.events.copySecret')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setCopied(false);
                      store.clearSigningSecret();
                    }}
                  >
                    {t('bots.events.secretHide')}
                  </button>
                </div>
                <p className="field__meta" role="status">
                  {copyError ? t('bots.copyError') : t('bots.events.secretOnceLead')}
                </p>
              </div>
            ) : (
              <div className="bot-events__secret-actions">
                <p className="field__meta">
                  {row.has_signing_secret
                    ? t('bots.events.secretSet', {
                        date: formatDateTime(row.signing_secret_created_at),
                      })
                    : t('bots.events.secretMissing')}
                </p>
                {secretConfirm ? (
                  <div className="bot-events__confirm" role="group">
                    <p className="field__meta" role="alert">
                      {t('bots.events.secretRotateConfirm')}
                    </p>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={secretPending}
                      onClick={() => void rotateSecret()}
                    >
                      {secretPending ? t('bots.events.saving') : t('bots.events.secretRotateYes')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={secretPending}
                      onClick={() => setSecretConfirm(false)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={secretPending}
                    onClick={() => setSecretConfirm(true)}
                  >
                    {row.has_signing_secret
                      ? t('bots.events.secretRotate')
                      : t('bots.events.secretCreate')}
                  </button>
                )}
                {secretError ? (
                  <p className="chat-settings-error" role="alert">
                    {deliveryErrorText(secretError)}
                  </p>
                ) : null}
              </div>
            )}
            <p className="field__meta" id={secretHintId}>
              {t('bots.events.secretHint')}
            </p>
          </section>

          <section className="bot-events__section" aria-labelledby={deliveriesTitleId}>
            <div className="bot-events__section-head">
              <h3 className="bot-events__title" id={deliveriesTitleId}>
                {t('bots.events.deliveriesTitle')}
              </h3>
              <button
                type="button"
                className="btn btn--sm"
                disabled={loadingDeliveries}
                aria-busy={loadingDeliveries}
                onClick={() => void store.loadBotDeliveries(workspaceId, bot.id, 20, true)}
              >
                <RefreshIcon aria-hidden="true" />
                {loadingDeliveries ? t('bots.events.deliveriesLoading') : t('bots.events.refresh')}
              </button>
            </div>
            <p className="field__meta">{t('bots.events.deliveriesHint')}</p>

            {deliveries?.status === 'error' && deliveries.error ? (
              <div className="members-list__state" role="alert">
                <p>{deliveryErrorText(deliveries.error)}</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void store.loadBotDeliveries(workspaceId, bot.id, 20, true)}
                >
                  {t('bots.retry')}
                </button>
              </div>
            ) : null}

            {!loadingDeliveries && deliveryRows.length === 0 ? (
              <p className="card-empty">{t('bots.events.deliveriesEmpty')}</p>
            ) : null}

            {deliveryRows.length > 0 ? (
              <ul className="bot-delivery-list" aria-label={t('bots.events.deliveriesTitle')}>
                {deliveryRows.map((delivery) => (
                  <DeliveryRow key={delivery.id} delivery={delivery} />
                ))}
              </ul>
            ) : null}

            {testError ? (
              <p className="chat-settings-error" role="alert">
                {deliveryErrorText(testError)}
              </p>
            ) : null}
            {testAccepted ? (
              <p className="chat-settings-notice" role="status">
                {t('bots.events.testAccepted', { id: testAccepted.deliveryId })}
              </p>
            ) : null}
            <div className="bot-events__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={testPending || saving}
                onClick={() => void store.testBotEvent(workspaceId, bot.id)}
              >
                {testPending ? t('bots.events.testPending') : t('bots.events.test')}
              </button>
            </div>
          </section>

          <div className="bot-events__save">
            <button
              type="button"
              className="btn btn--accent"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? t('bots.events.saving') : t('bots.events.save')}
            </button>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn--accent" onClick={onClose}>
            {t('bots.events.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeliveryRow({ delivery }: { delivery: BotDelivery }) {
  const status = delivery.status;
  return (
    <li className="bot-delivery-row">
      <span className={`bot-delivery-status bot-delivery-status--${status.toLowerCase()}`}>
        {t(DELIVERY_STATUS_LABEL[status])}
      </span>
      <span className="bot-delivery-row__type">{eventTypeLabel(delivery.event_type)}</span>
      <span className="bot-delivery-row__time">
        {t('bots.meta.created', { date: formatDateTime(delivery.created_at) })}
      </span>
      <span className="bot-delivery-row__attempts">
        {t('bots.events.deliveryAttempts', { count: delivery.attempt_count })}
      </span>
      {delivery.delivered_at ? (
        <span className="bot-delivery-row__meta">
          {t('bots.events.deliveryDeliveredAt', { date: formatDateTime(delivery.delivered_at) })}
        </span>
      ) : null}
      {delivery.last_status_code !== null && delivery.last_status_code !== undefined ? (
        <span className="bot-delivery-row__meta">
          {t('bots.events.deliveryHttp', { code: delivery.last_status_code })}
        </span>
      ) : null}
      {delivery.last_error ? (
        <span className="bot-delivery-row__meta">
          {t('bots.events.deliveryError', { reason: delivery.last_error })}
        </span>
      ) : null}
      {delivery.status === 'PENDING' && delivery.next_attempt_at ? (
        <span className="bot-delivery-row__meta">
          {t('bots.events.deliveryNextAttempt', {
            date: formatDateTime(delivery.next_attempt_at),
          })}
        </span>
      ) : null}
    </li>
  );
}
