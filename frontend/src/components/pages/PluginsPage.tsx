import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChatPluginState, Plugin, SecurityMode } from '../../api/types';
import { chatDisplayName } from '../../domain/chatLabel';
import { describeError } from '../../domain/errors';
import { t, type MessageKey } from '../../i18n/ru';
import {
  PLUGIN_MODE_LABEL,
  PLUGIN_PERMISSION_LABEL,
  UNAVAILABLE_REASON_LABEL,
  enabledPluginCount,
  pluginStateMap,
} from '../../plugins/model';
import {
  useChatState,
  useChatStore,
  usePluginsState,
  usePluginsStore,
} from '../../store/ChatProvider';
import {
  LockIcon,
  PlugIcon,
  PollIcon,
  RefreshIcon,
  ShieldIcon,
  StickerIcon,
  TaskIcon,
  TranslateIcon,
} from '../Icons';
import { useNavigate } from '../../router/router';
import { ExternalPluginRunner } from '../plugins/ExternalPluginRunner';
import { PageShell } from './PageShell';
import { securityModeLabel } from './pageData';

/**
 * Closed `icon` tokens from `plugin.catalog` mapped to bundled SVG icons. An
 * unknown token falls back to the generic plug; the server value is never
 * treated as a URL or HTML.
 */
const ICONS: Readonly<Record<string, ReactNode>> = {
  poll: <PollIcon />,
  task: <TaskIcon />,
  translate: <TranslateIcon />,
  plug: <PlugIcon />,
  shield: <ShieldIcon />,
  stickers: <StickerIcon />,
};

function pluginIcon(icon: string | null | undefined): ReactNode {
  return (icon ? ICONS[icon] : undefined) ?? <PlugIcon />;
}

function permissionLabel(permission: Plugin['permissions'][number]): MessageKey {
  return PLUGIN_PERMISSION_LABEL[permission];
}

type ToggleReason =
  | { kind: 'reason'; label: MessageKey }
  | { kind: 'permission' }
  | { kind: 'pending' }
  | { kind: 'loading' }
  | { kind: 'noChat' };

interface PluginCardProps {
  plugin: Plugin;
  stateItem: ChatPluginState | undefined;
  chatReady: boolean;
  chatLoading: boolean;
  chatFailed: boolean;
  hasChat: boolean;
  canManage: boolean;
  pending: boolean;
  onToggle: (plugin: Plugin, enabled: boolean) => void;
  /** Present only for `kind=EXTERNAL` catalog rows. */
  onOpen?: (plugin: Plugin) => void;
}

function PluginCard({
  plugin,
  stateItem,
  chatReady,
  chatLoading,
  chatFailed,
  hasChat,
  canManage,
  pending,
  onToggle,
  onOpen,
}: PluginCardProps) {
  const available = stateItem?.available ?? false;
  const checked = stateItem?.enabled ?? false;
  const disabled = !chatReady || !stateItem || !available || !canManage || pending;

  let reason: ToggleReason | null = null;
  if (pending) reason = { kind: 'pending' };
  else if (!hasChat) reason = { kind: 'noChat' };
  else if (!stateItem) {
    if (chatLoading) reason = { kind: 'loading' };
    else if (chatFailed) reason = { kind: 'reason', label: 'plugins.reasonError' };
    else reason = { kind: 'reason', label: 'plugins.toggleUnavailable' };
  } else if (!available) {
    reason = {
      kind: 'reason',
      label: stateItem.reason
        ? UNAVAILABLE_REASON_LABEL[stateItem.reason]
        : 'plugins.toggleUnavailable',
    };
  } else if (!canManage) reason = { kind: 'permission' };

  const reasonId = `plugin-reason-${plugin.id}`;
  const reasonText =
    reason === null
      ? null
      : reason.kind === 'permission'
        ? t('plugins.reasonDenied')
        : reason.kind === 'pending'
          ? t('plugins.reasonPending')
          : reason.kind === 'loading'
            ? t('plugins.reasonLoading')
            : reason.kind === 'noChat'
              ? t('plugins.reasonNoChat')
              : t(reason.label);

  return (
    <article
      className={`plugin-card card${available ? '' : ' plugin-card--unavailable'}`}
      aria-labelledby={`plugin-title-${plugin.id}`}
    >
      <div className="plugin-head">
        <span className="plugin-ic" aria-hidden="true">
          {pluginIcon(plugin.icon)}
        </span>
        <div className="plugin-copy">
          <h3 id={`plugin-title-${plugin.id}`}>{plugin.name}</h3>
          <p>{plugin.description}</p>
          {plugin.kind === 'EXTERNAL' ? (
            <div className="plugin-external-meta">
              <span className="perm plugin-external-meta__badge">
                {t('plugins.external.badge')}
              </span>
              {plugin.version ? (
                <span className="perm">
                  {t('plugins.external.version', { version: plugin.version })}
                </span>
              ) : null}
              {plugin.author ? (
                <span className="perm">
                  {t('plugins.external.author', { author: plugin.author })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {onOpen ? (
        <div className="plugin-actions">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onOpen(plugin)}
            disabled={plugin.state === 'DISABLED' || !plugin.entry_url}
            aria-label={t('plugins.external.openHint', { name: plugin.name })}
            title={
              !plugin.entry_url
                ? t('plugins.external.noEntry')
                : plugin.state === 'DISABLED'
                  ? t('plugins.external.disabled')
                  : t('plugins.external.openHint', { name: plugin.name })
            }
          >
            {t('plugins.external.open')}
          </button>
        </div>
      ) : null}

      <div className="plugin-foot">
        <span className="visually-hidden">{t('plugins.permsLabel')}: </span>
        {plugin.permissions.length === 0 ? (
          <span className="perm">{t('plugins.external.noPermissions')}</span>
        ) : (
          plugin.permissions.map((permission) => (
            <span className="perm" key={permission}>
              {t(permissionLabel(permission))}
            </span>
          ))
        )}
        <span className="visually-hidden">{t('plugins.modesLabel')}: </span>
        {plugin.modes.map((mode) => (
          <span
            className={`mode-chip mode-chip--${mode === 'E2EE' ? 'e2ee' : 'managed'}`}
            key={mode}
          >
            {t(PLUGIN_MODE_LABEL[mode])}
          </span>
        ))}
        {reasonText ? (
          <span className={`plugin-reason${disabled ? ' plugin-reason--off' : ''}`} id={reasonId}>
            {reasonText}
          </span>
        ) : null}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={t(checked ? 'plugins.toggleOff' : 'plugins.toggleOn', { name: plugin.name })}
        aria-describedby={reasonText ? reasonId : undefined}
        className={`plugin-switch${checked ? ' is-on' : ''}${pending ? ' is-pending' : ''}`}
        disabled={disabled}
        title={reasonText ?? undefined}
        onClick={() => onToggle(plugin, !checked)}
      >
        <span className="plugin-switch__thumb" aria-hidden="true" />
      </button>
    </article>
  );
}

interface PluginsPageProps {
  onBack: () => void;
  embedded?: boolean;
}

/**
 * D1.1 (#69) plugins surface. The catalog is the closed first-party list from
 * `GET /plugins`; switches come from `GET /chats/{chatId}/plugins` and are
 * chat-scoped. The page never applies an optimistic update, never offers
 * install/marketplace actions and never invents plugins or permissions.
 *
 * Chat management is chat OWNER/ADMIN only on the server. The client can see
 * the workspace role in the contract, not the chat role, so it uses the
 * workspace OWNER/ADMIN as the affordance hint and still handles `403`
 * honestly if the server rejects the change.
 */
export function PluginsPage({ onBack, embedded = false }: PluginsPageProps) {
  const state = useChatState();
  const chatStore = useChatStore();
  const store = usePluginsStore();
  const plugins = usePluginsState();
  const navigate = useNavigate();
  const isAdmin = state.me?.user.is_platform_admin === true;
  const [activeExternal, setActiveExternal] = useState<Plugin | null>(null);
  const loadEntry = useCallback((entryUrl: string) => store.readPluginEntry(entryUrl), [store]);
  const loadAsset = useCallback(
    (entryUrl: string, assetPath: string) => store.readPluginAsset(entryUrl, assetPath),
    [store],
  );

  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const workspaceMode: SecurityMode =
    state.activeWorkspace?.security_mode ?? state.session?.workspace.security_mode ?? 'MANAGED';
  /**
   * `ChatSummary` has no role and the plugin contract has no "can manage" flag.
   * Prefer the workspace membership snapshot; the dev-session profile does not
   * populate it, so fall back to the already loaded member directory. The
   * server still enforces chat OWNER/ADMIN and any `403` is surfaced below.
   */
  const activeWorkspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;
  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const workspaceRole =
    state.activeWorkspace?.role ??
    state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.role ??
    state.me?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.role ??
    state.workspaceMembers.items.find((member) => member.user_id === viewerId)?.role ??
    null;
  const canManage = workspaceRole === 'OWNER' || workspaceRole === 'ADMIN';
  const builtinPlugins = useMemo(
    () => plugins.catalog.filter((plugin) => plugin.kind !== 'EXTERNAL'),
    [plugins.catalog],
  );
  const externalPlugins = useMemo(
    () => plugins.catalog.filter((plugin) => plugin.kind === 'EXTERNAL'),
    [plugins.catalog],
  );

  const groupChats = useMemo(
    () => state.chats.filter((chat) => chat.type === 'GROUP'),
    [state.chats],
  );
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedChatId((current) => {
      if (current && groupChats.some((chat) => chat.id === current)) return current;
      const active = groupChats.find((chat) => chat.id === state.activeChatId);
      return active?.id ?? groupChats[0]?.id ?? null;
    });
  }, [groupChats, state.activeChatId]);

  useEffect(() => {
    void store.ensureCatalog();
  }, [store]);

  useEffect(() => {
    if (selectedChatId) void store.ensureChat(selectedChatId);
  }, [store, selectedChatId]);

  useEffect(() => {
    // Only the dev-session bootstrap lacks a workspace role; the member
    // directory is the existing read that carries it. Password auth already
    // has `activeWorkspace.role`, so this never fires there.
    if (workspaceRole !== null) return;
    if (state.sessionStatus !== 'ready') return;
    if (state.workspaceMembers.status !== 'idle') return;
    if (state.workspaceMembers.items.length > 0) return;
    void chatStore.loadWorkspaceMembers();
  }, [
    chatStore,
    workspaceRole,
    state.sessionStatus,
    state.workspaceMembers.status,
    state.workspaceMembers.items.length,
  ]);

  const selectedChat = groupChats.find((chat) => chat.id === selectedChatId) ?? null;
  const mode: SecurityMode = selectedChat?.security_mode ?? workspaceMode;
  const isE2ee = mode === 'E2EE';

  const stateMap = useMemo(() => pluginStateMap(plugins.chatStates), [plugins.chatStates]);
  const chatReady = plugins.chatStatus === 'ready' && plugins.chatId === selectedChatId;
  const chatLoading = plugins.chatStatus === 'loading' && plugins.chatId === selectedChatId;
  const enabledCount = chatReady ? enabledPluginCount(plugins.chatStates) : null;
  const catalogReady = plugins.catalogStatus === 'ready';
  const catalogError = plugins.catalogStatus === 'error' ? plugins.catalogError : null;
  const chatError =
    plugins.chatStatus === 'error' && plugins.chatId === selectedChatId ? plugins.chatError : null;

  const refresh = () => {
    void store.loadCatalog(true);
    if (selectedChatId) void store.loadChat(selectedChatId, true);
  };

  const toggleError = plugins.toggleError;
  const toggleErrorText = toggleError
    ? toggleError.status === 403
      ? t('plugins.toggleForbidden')
      : toggleError.code === 'PLUGIN_NOT_AVAILABLE'
        ? t('plugins.reasonNotAvailable')
        : toggleError.code === 'PLUGIN_DISABLED'
          ? t('plugins.reasonDisabled')
          : describeError(toggleError).message
    : null;

  const lastToggle = plugins.lastToggle;
  const lastPluginName =
    (lastToggle && plugins.catalog.find((plugin) => plugin.id === lastToggle.pluginId)?.name) ??
    lastToggle?.pluginId ??
    '';

  return (
    <PageShell
      embedded={embedded}
      title={t('plugins.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(workspaceMode)}`}
      onBack={onBack}
      actions={
        <>
          {isAdmin ? (
            <button
              type="button"
              className="btn"
              onClick={() => navigate('/admin?tab=plugins')}
              title={t('plugins.external.manageHint')}
            >
              <span>{t('plugins.external.manage')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={refresh}
            aria-label={t('plugins.refresh')}
            title={t('plugins.refreshHint')}
          >
            <RefreshIcon aria-hidden="true" />
            <span>{t('plugins.refresh')}</span>
          </button>
        </>
      }
    >
      {groupChats.length === 0 ? (
        <section className="card pg-empty-banner" aria-labelledby="plugins-no-chat">
          <span className="empty-panel__icon" aria-hidden="true">
            <PlugIcon />
          </span>
          <div>
            <h2 className="card-title" id="plugins-no-chat">
              {t('plugins.noGroupChatsTitle')}
            </h2>
            <p className="card-empty">{t('plugins.noGroupChatsText')}</p>
          </div>
        </section>
      ) : (
        <section className="card plugin-chatbar" aria-labelledby="plugins-chat-label">
          <div className="plugin-chatbar__field">
            <label htmlFor="plugins-chat-select" id="plugins-chat-label">
              {t('plugins.chatLabel')}
            </label>
            <select
              id="plugins-chat-select"
              value={selectedChatId ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                setSelectedChatId(next.length > 0 ? next : null);
              }}
            >
              {groupChats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {`${chatDisplayName(chat, state.workspaceMembers.items)} · ${securityModeLabel(
                    chat.security_mode,
                  )}`}
                </option>
              ))}
            </select>
          </div>
          <div className="plugin-chatbar__meta">
            <span className={`mode-chip mode-chip--${isE2ee ? 'e2ee' : 'managed'}`}>
              {securityModeLabel(mode)}
            </span>
            {enabledCount !== null ? (
              <span className="chip">
                {t('plugins.enabledCount', {
                  enabled: enabledCount,
                  total: plugins.chatStates.length,
                })}
              </span>
            ) : null}
            {catalogReady ? (
              <span className="chip">
                {t('plugins.catalogCount', { count: plugins.catalog.length })}
              </span>
            ) : null}
          </div>
        </section>
      )}
      <p className="plugin-chat-hint">
        {t('plugins.chatHint')} {t('plugins.builtinNote')}
      </p>

      {isE2ee ? (
        <section className="card plugin-e2ee" aria-labelledby="plugins-e2ee-title">
          <span className="plugin-e2ee__icon" aria-hidden="true">
            <LockIcon />
          </span>
          <div>
            <h2 className="card-title" id="plugins-e2ee-title">
              {t('plugins.e2eeTitle')}
            </h2>
            <p className="card-empty">{t('plugins.e2eeText')}</p>
          </div>
        </section>
      ) : null}

      {catalogError ? (
        <section className="card pg-error" role="alert">
          <div>
            <h2 className="card-title">{t('plugins.catalogErrorTitle')}</h2>
            <p className="card-empty">{describeError(catalogError).message}</p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadCatalog(true)}
          >
            {t('plugins.retry')}
          </button>
        </section>
      ) : null}

      {chatError ? (
        <section className="card pg-error" role="alert">
          <div>
            <h2 className="card-title">{t('plugins.chatErrorTitle')}</h2>
            <p className="card-empty">{describeError(chatError).message}</p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => selectedChatId && void store.loadChat(selectedChatId, true)}
          >
            {t('plugins.retry')}
          </button>
        </section>
      ) : null}

      {plugins.catalogStatus === 'loading' && !catalogReady ? (
        <section className="card plugin-loading" role="status">
          <p>{t('plugins.catalogLoading')}</p>
        </section>
      ) : null}

      {catalogReady && chatLoading ? (
        <p className="plugin-chat-loading" role="status">
          {t('plugins.chatLoading')}
        </p>
      ) : null}

      {toggleErrorText ? (
        <section className="card pg-error plugin-toggle-error" role="alert">
          <div>
            <h2 className="card-title">{t('plugins.toggleErrorTitle')}</h2>
            <p className="card-empty">{toggleErrorText}</p>
          </div>
        </section>
      ) : null}

      {lastToggle ? (
        <p className="plugin-feedback" role="status" aria-live="polite">
          {lastToggle.changed
            ? t(lastToggle.enabled ? 'plugins.toggleSavedOn' : 'plugins.toggleSavedOff', {
                name: lastPluginName,
              })
            : t('plugins.toggleNoop')}
        </p>
      ) : null}

      {catalogReady && plugins.catalog.length === 0 ? (
        <section className="card pg-empty-banner" aria-labelledby="plugins-empty">
          <span className="empty-panel__icon" aria-hidden="true">
            <PlugIcon />
          </span>
          <div>
            <h2 className="card-title" id="plugins-empty">
              {t('plugins.emptyTitle')}
            </h2>
            <p className="card-empty">{t('plugins.emptyText')}</p>
          </div>
        </section>
      ) : null}

      {catalogReady && builtinPlugins.length > 0 ? (
        <section className="plugin-section" aria-labelledby="plugins-builtin-title">
          <div className="plugin-section__head">
            <h2 className="plugin-section__title" id="plugins-builtin-title">
              {t('plugins.external.sectionBuiltin')}
            </h2>
            <span className="chip">
              {t('plugins.catalogCount', { count: builtinPlugins.length })}
            </span>
          </div>
          <div className="plugin-grid" aria-busy={plugins.chatStatus === 'loading'}>
            {builtinPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                stateItem={stateMap.get(plugin.id)}
                chatReady={chatReady}
                chatLoading={chatLoading}
                chatFailed={chatError !== null}
                hasChat={selectedChat !== null}
                canManage={canManage}
                pending={plugins.pendingPluginIds.includes(plugin.id)}
                onToggle={(target, enabled) => {
                  if (selectedChatId) void store.toggle(selectedChatId, target.id, enabled);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {catalogReady ? (
        <section className="plugin-section" aria-labelledby="plugins-external-title">
          <div className="plugin-section__head">
            <h2 className="plugin-section__title" id="plugins-external-title">
              {t('plugins.external.sectionExternal')}
            </h2>
            <span className="chip">
              {t('plugins.external.count', { count: externalPlugins.length })}
            </span>
          </div>
          {externalPlugins.length === 0 ? (
            <section className="card pg-empty-banner" aria-labelledby="plugins-external-empty">
              <span className="empty-panel__icon" aria-hidden="true">
                <PlugIcon />
              </span>
              <div>
                <h3 className="card-title" id="plugins-external-empty">
                  {t('plugins.external.emptyTitle')}
                </h3>
                <p className="card-empty">{t('plugins.external.emptyText')}</p>
              </div>
            </section>
          ) : (
            <div
              className="plugin-grid plugin-grid--external"
              aria-busy={plugins.chatStatus === 'loading'}
            >
              {externalPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  stateItem={stateMap.get(plugin.id)}
                  chatReady={chatReady}
                  chatLoading={chatLoading}
                  chatFailed={chatError !== null}
                  hasChat={selectedChat !== null}
                  canManage={canManage}
                  pending={plugins.pendingPluginIds.includes(plugin.id)}
                  onOpen={(target) => setActiveExternal(target)}
                  onToggle={(target, enabled) => {
                    if (selectedChatId) void store.toggle(selectedChatId, target.id, enabled);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      <div className="plugin-note">
        <LockIcon aria-hidden="true" />
        <span>{isE2ee ? t('plugins.noteE2ee') : t('plugins.note')}</span>
      </div>

      {activeExternal ? (
        <ExternalPluginRunner
          plugin={activeExternal}
          chatId={selectedChatId}
          onClose={() => setActiveExternal(null)}
          loadEntry={loadEntry}
          loadAsset={loadAsset}
        />
      ) : null}
    </PageShell>
  );
}
