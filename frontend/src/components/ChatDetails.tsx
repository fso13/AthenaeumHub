import { useEffect, useMemo, useState } from 'react';
import type { ChatSummary, WorkspaceMemberRole } from '../api/types';
import { chatDisplayName } from '../domain/chatLabel';
import { isSafePreviewImage, safeHttpUrl } from '../files/format';
import { t, type MessageKey } from '../i18n/ru';
import { enabledPluginCount } from '../plugins/model';
import { usePluginGate } from '../plugins/gate';
import {
  useChatState,
  useChatStore,
  useFilesStore,
  usePluginActionsState,
  usePluginsState,
  usePluginsStore,
} from '../store/ChatProvider';
import type { ChatSlice } from '../store/chatStore';
import { Avatar } from './Avatar';
import {
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  FlagIcon,
  ImageIcon,
  KeyIcon,
  LockIcon,
  LogoutIcon,
  MusicIcon,
  PeopleIcon,
  PhoneIcon,
  PlayIcon,
  PlugIcon,
  PollIcon,
  SearchIcon,
  TaskIcon,
  SettingsIcon,
  ShieldIcon,
  UserPlusIcon,
} from './Icons';
import { NotificationPreferencesDialog } from './NotificationPreferencesDialog';
import { PollPanel } from './plugins/PollPanel';
import { TaskPanel } from './plugins/TaskPanel';
import { extensionOf, fileKind, pluralRu } from './pages/pageData';

const ROLE_LABEL: Record<WorkspaceMemberRole, MessageKey> = {
  OWNER: 'details.role.OWNER',
  ADMIN: 'details.role.ADMIN',
  MEMBER: 'details.role.MEMBER',
  GUEST: 'details.role.GUEST',
};

interface ChatDetailsProps {
  open: boolean;
  chat: ChatSummary | null;
  slice: ChatSlice | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenSafety: () => void;
  onOpenMembers?: () => void;
  onNavigate: (view: 'plugins' | 'security') => void;
  searchValue: string;
  onSearch: (value: string) => void;
  /** §9/#77: audio call from the details footer (DIRECT/GROUP managed only). */
  onStartCall?: (video: boolean) => void;
  /** Honest reason the details call row is disabled, or null when available. */
  callDisabledReason?: string | null;
  /** D1.1 (#76): open the poll/task accordion after a successful create. */
  pluginPanelRequest?: { panel: 'polls' | 'tasks'; nonce: number } | null;
}

interface MediaItem {
  id: string;
  name: string;
  url: string | null;
  kind: 'image' | 'video' | 'audio' | 'file';
  ext: string;
  mimeType: string | null;
  scanStatus: string;
}

const COVER_BY_MODE = {
  managed: '/covers/cover-atlas.svg',
  e2ee: '/covers/cover-family.svg',
  direct: '/covers/cover-dm.svg',
} as const;

/**
 * Every loaded attachment becomes a tile. The old implementation dropped
 * plain files (`kind === 'FILE' && !artwork_url`) and reported an empty grid
 * even when a message carried attachments; here the count is the real total and
 * artwork is an optional enhancement.
 */
function mediaItems(slice: ChatSlice | null): { items: MediaItem[]; total: number } {
  const items: MediaItem[] = [];
  if (!slice) return { items, total: 0 };
  for (let index = slice.messages.length - 1; index >= 0; index -= 1) {
    const message = slice.messages[index];
    for (const attachment of message?.attachments ?? []) {
      const media = attachment.media;
      const kind = fileKind(attachment.mime_type, attachment.filename);
      items.push({
        id: attachment.id,
        name: attachment.filename ?? t('attachments.attachmentOnly'),
        url: safeHttpUrl(media?.artwork_url),
        kind:
          kind === 'image'
            ? 'image'
            : kind === 'video'
              ? 'video'
              : kind === 'audio'
                ? 'audio'
                : 'file',
        ext: extensionOf(attachment.filename),
        mimeType: attachment.mime_type ?? null,
        scanStatus: attachment.scan_status ?? 'PENDING',
      });
    }
  }
  return { items, total: items.length };
}

function mediaFallback(kind: MediaItem['kind']) {
  if (kind === 'audio') return <MusicIcon aria-hidden="true" />;
  if (kind === 'video') return <PlayIcon aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon aria-hidden="true" />;
  return <FileIcon aria-hidden="true" />;
}

/**
 * The details grid must show real image previews, not just an extension badge.
 * Presigned URLs are requested lazily only for CLEAN raster images; audio,
 * video and plain files keep the safe icon fallback (no extra API calls).
 */
function MediaPreview({ item }: { item: MediaItem }) {
  const files = useFilesStore();
  const [url, setUrl] = useState<string | null>(item.url);
  useEffect(() => {
    setUrl(item.url);
    if (!isSafePreviewImage(item.mimeType) || item.scanStatus !== 'CLEAN') return;
    let active = true;
    void files
      .getDownloadUrl(item.id)
      .then((download) => {
        if (active) setUrl(download.url);
      })
      .catch(() => {
        // Keep the icon fallback; the attachment card has its own retry path.
      });
    return () => {
      active = false;
    };
  }, [files, item.id, item.kind, item.scanStatus, item.url]);

  if (url && isSafePreviewImage(item.mimeType)) {
    return (
      <img
        src={url}
        alt={item.name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setUrl(null)}
      />
    );
  }
  return <span className="media-tile__fallback">{mediaFallback(item.kind)}</span>;
}

/**
 * D1 UX fidelity 2: the right-hand details column rebuilt after
 * `design/dashboard` v1.0.0 — cover asset, squircle avatar, chips, rows in the
 * reference order, a real attachment grid and honest disabled actions.
 */
export function ChatDetails({
  open,
  chat,
  slice,
  onClose,
  onOpenSettings,
  onOpenSafety,
  onOpenMembers,
  onNavigate,
  searchValue,
  onSearch,
  onStartCall,
  callDisabledReason = null,
  pluginPanelRequest = null,
}: ChatDetailsProps) {
  const store = useChatStore();
  const state = useChatState();
  const pluginsStore = usePluginsStore();
  const pluginsState = usePluginsState();
  const pluginActions = usePluginActionsState();
  const [expanded, setExpanded] = useState<
    'privacy' | 'members' | 'plugins' | 'media' | 'polls' | 'tasks' | null
  >('media');
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const securityMode =
    chat?.security_mode ??
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    'MANAGED';
  const isDirect = chat?.type === 'DIRECT';
  const isE2ee = securityMode === 'E2EE';
  const name = chatDisplayName(
    chat,
    state.workspaceMembers.items,
    state.session?.chat.name ?? null,
  );
  const peer = isDirect
    ? (state.workspaceMembers.items.find((member) => member.user_id === chat?.peer_id) ??
      state.workspaceMembers.items.find(
        (member) => member.display_name.trim() === (chat?.name ?? '').trim(),
      ) ??
      null)
    : null;
  const members = state.workspaceMembers.items;
  const membersReady = state.workspaceMembers.status === 'ready';
  const onlineCount = useMemo(() => {
    const count = Object.values(state.presence).filter(
      (presence) => presence.status === 'ONLINE',
    ).length;
    return members.length > 0 ? Math.min(count, members.length) : count;
  }, [members.length, state.presence]);
  const peerOnline = peer ? state.presence[peer.user_id]?.status === 'ONLINE' : false;

  const subtitle = isDirect
    ? peer
      ? t(peerOnline ? 'details.dmSubtitle' : 'details.dmSubtitleOffline', {
          role: t(ROLE_LABEL[peer.role]),
        })
      : t('details.dmSubtitleUnknown')
    : membersReady
      ? t('details.membersCount', {
          count: members.length,
          noun: pluralRu(members.length, 'участник', 'участника', 'участников'),
          online: onlineCount,
        })
      : state.workspaceMembers.status === 'loading'
        ? t('details.membersCountLoading')
        : t('details.membersCountFallback');

  const viewerId = state.user?.id ?? state.session?.user.id ?? null;
  const { items: media, total: mediaTotal } = useMemo(() => mediaItems(slice), [slice]);
  /**
   * D1.1 (#69): the row shows the real server count for this chat. The store
   * caches one chat at a time, so the panel only trusts rows whose `chatId`
   * matches; a loading/error row renders `—` instead of a fake number.
   */
  const pluginChatId = chat?.id ?? null;
  const pluginChatIsDirect = chat?.type === 'DIRECT';
  const pluginRows = pluginsState.chatId === pluginChatId ? pluginsState.chatStates : [];
  const pluginChatReady =
    pluginsState.chatId === pluginChatId && pluginsState.chatStatus === 'ready';
  const enabledPlugins = pluginChatReady ? enabledPluginCount(pluginRows) : null;
  const pluginChatError =
    pluginsState.chatId === pluginChatId && pluginsState.chatStatus === 'error'
      ? pluginsState.chatError
      : null;
  /**
   * D1.1 (#76): poll/task panels are chat-scoped and render only when the
   * server says the plugin is enabled+available for this managed chat.
   */
  const pluginGate = usePluginGate(pluginChatId, isE2ee);
  const pollsEnabled = !isDirect && pluginGate.enabled('polls');
  const tasksEnabled = !isDirect && pluginGate.enabled('tasks');
  const pluginActionsCurrent = pluginActions.chatId === pluginChatId;
  const pollCount =
    pluginActionsCurrent && pluginActions.pollsStatus === 'ready'
      ? pluginActions.polls.length
      : null;
  const openTaskCount =
    pluginActionsCurrent && pluginActions.tasksStatus === 'ready'
      ? pluginActions.tasks.filter((task) => !task.done).length
      : null;
  const cover = isDirect
    ? COVER_BY_MODE.direct
    : isE2ee
      ? COVER_BY_MODE.e2ee
      : COVER_BY_MODE.managed;

  useEffect(() => {
    // The attachment grid is part of the panel body in the v1 layout and starts
    // open; privacy/members/plugins remain accordions.
    setExpanded('media');
    setNotificationsOpen(false);
  }, [chat?.id]);

  useEffect(() => {
    // The panel subtitle shows an approximate participant/online count from
    // the existing workspace directory; load it once when the panel is open.
    if (!open) return;
    if (state.workspaceMembers.status === 'idle' && state.workspaceMembers.items.length === 0) {
      void store.loadWorkspaceMembers();
    }
  }, [open, state.workspaceMembers.items.length, state.workspaceMembers.status, store]);

  useEffect(() => {
    // Plugin state is chat-scoped and loaded lazily by the panel. Deduped by
    // the store, so reopening details does not spend a second GET.
    if (!open || !pluginChatId || pluginChatIsDirect) return;
    void pluginsStore.ensureChat(pluginChatId);
  }, [open, pluginChatId, pluginChatIsDirect, pluginsStore]);

  useEffect(() => {
    if (!open || !pluginPanelRequest) return;
    setExpanded(pluginPanelRequest.panel);
  }, [open, pluginPanelRequest]);

  const toggle = (panel: 'privacy' | 'members' | 'plugins' | 'media' | 'polls' | 'tasks') => {
    setExpanded((current) => (current === panel ? null : panel));
    // The directory is read lazily: opening the panel must not spend a
    // `GET /workspaces/{id}/members` call before the user asks for members.
    if (panel === 'members' && expanded !== 'members') {
      if (state.workspaceMembers.status === 'idle' && state.workspaceMembers.items.length === 0) {
        void store.loadWorkspaceMembers();
      }
    }
  };

  const attachmentsOpen = expanded === 'media';
  const loadedAttachments = mediaTotal > 0;

  return (
    <aside
      className={`details${open ? ' details--open' : ''}`}
      aria-label={t('chat.detailsToggle')}
    >
      <button
        type="button"
        className="details-close"
        onClick={onClose}
        aria-label={t('chat.detailsClose')}
        title={t('chat.detailsClose')}
      >
        <CloseIcon aria-hidden="true" />
      </button>

      <div className="details-inner">
        <div className={`profile-cover profile-cover--${isE2ee ? 'e2ee' : 'managed'}`}>
          <img className="profile-cover__img" src={cover} alt="" draggable={false} />
        </div>

        <div className="profile-main">
          <Avatar
            name={isDirect ? (peer?.display_name ?? name) : name}
            seed={chat?.peer_id ?? chat?.id ?? name}
            size="profile"
          />
          <p className="profile-name">{name}</p>
          <p className="profile-sub">{subtitle}</p>
          <div className="chips">
            {isDirect ? (
              <>
                <span className="chip">{t('chat.direct')}</span>
                <span className={`chip${isE2ee ? ' chip--accent' : ''}`}>
                  <LockIcon aria-hidden="true" />
                  {isE2ee ? t('details.secretChip') : t('details.serverEncryption')}
                </span>
              </>
            ) : (
              <>
                <span className={`chip${isE2ee ? ' chip--accent' : ''}`}>
                  <LockIcon aria-hidden="true" />
                  {isE2ee ? t('chat.e2eeChip') : t('chat.managedChip')}
                </span>
                <span className="chip">{t('chat.group')}</span>
              </>
            )}
          </div>
        </div>

        <label className="panel-search">
          <SearchIcon aria-hidden="true" />
          <span className="visually-hidden">{t('details.search')}</span>
          <input
            type="search"
            value={searchValue}
            placeholder={t('details.search')}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>

        <div className="panel-rows">
          <button type="button" className="panel-row" onClick={onOpenSettings}>
            <SettingsIcon aria-hidden="true" />
            <span>{t('details.settings')}</span>
            <ChevronRightIcon className="chev" aria-hidden="true" />
          </button>

          <button
            type="button"
            className={`panel-row${expanded === 'privacy' ? ' is-open' : ''}`}
            aria-expanded={expanded === 'privacy'}
            onClick={() => toggle('privacy')}
          >
            <LockIcon aria-hidden="true" />
            <span>{t('details.privacy')}</span>
            <ChevronDownIcon className="chev" aria-hidden="true" />
          </button>
          {expanded === 'privacy' ? (
            <div className="panel-expand">
              {isE2ee ? (
                <>
                  <div className="secure">
                    <div className="secure-head">
                      <ShieldIcon aria-hidden="true" />
                      {t('details.e2eeTitle')}
                    </div>
                    <p>{t('details.e2eeText')}</p>
                    <button type="button" className="btn-sm btn-sm--accent" onClick={onOpenSafety}>
                      <ShieldIcon aria-hidden="true" />
                      {t('details.verifyKeys')}
                    </button>
                  </div>
                  <p className="hint">{t('chat.e2eeNote')}</p>
                </>
              ) : (
                <>
                  <p>
                    <b>{t('details.managedTitle')}.</b> {t('details.managedText')}
                  </p>
                  <p className="hint">{t('chat.managedNote')}</p>
                </>
              )}
            </div>
          ) : null}

          <button type="button" className="panel-row" onClick={() => setNotificationsOpen(true)}>
            <BellIcon aria-hidden="true" />
            <span>{t('details.notifications')}</span>
            <ChevronRightIcon className="chev" aria-hidden="true" />
          </button>

          {!isDirect && !isE2ee ? (
            <button type="button" className="panel-row" onClick={() => onNavigate('security')}>
              <ShieldIcon aria-hidden="true" />
              <span>{t('details.audit')}</span>
              <ChevronRightIcon className="chev" aria-hidden="true" />
            </button>
          ) : null}

          {isDirect ? (
            <button
              type="button"
              className="panel-row"
              disabled
              title={t('details.disabledAction')}
            >
              <KeyIcon aria-hidden="true" />
              <span>{t('details.secretChat')}</span>
              <span className="state">
                {isE2ee ? t('details.secretOn') : t('details.secretOff')}
              </span>
            </button>
          ) : null}

          {!isDirect ? (
            <>
              <button
                type="button"
                className={`panel-row${expanded === 'members' ? ' is-open' : ''}`}
                aria-expanded={expanded === 'members'}
                onClick={() => toggle('members')}
              >
                <PeopleIcon aria-hidden="true" />
                <span>{t('details.members')}</span>
                <span className="count">{members.length > 0 ? members.length : '—'}</span>
                <ChevronDownIcon className="chev" aria-hidden="true" />
              </button>
              {expanded === 'members' ? (
                <div className="panel-expand">
                  {members.length === 0 ? (
                    <p>
                      {state.workspaceMembers.status === 'loading'
                        ? t('common.loading')
                        : state.workspaceMembers.error
                          ? t('overview.membersError')
                          : t('details.membersHint')}
                    </p>
                  ) : (
                    <ul className="member-list">
                      {members.slice(0, 8).map((member) => (
                        <li className="member" key={member.user_id}>
                          <Avatar name={member.display_name} seed={member.user_id} size="xs" />
                          <span className="member-name">
                            {member.display_name}
                            {member.user_id === viewerId ? (
                              <span className="member-me"> · {t('details.me')}</span>
                            ) : null}
                          </span>
                          <span className={`role role--${member.role.toLowerCase()}`}>
                            {t(ROLE_LABEL[member.role])}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="hint">{t('details.participantsHint')}</p>
                  {onOpenMembers ? (
                    <button type="button" className="btn-sm" onClick={onOpenMembers}>
                      <UserPlusIcon aria-hidden="true" />
                      {t('details.openMembers')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {!isDirect ? (
            <>
              <button
                type="button"
                className={`panel-row${expanded === 'plugins' ? ' is-open' : ''}`}
                aria-expanded={expanded === 'plugins'}
                onClick={() => toggle('plugins')}
              >
                <PlugIcon aria-hidden="true" />
                <span>{t('details.plugins')}</span>
                <span className="count">{enabledPlugins !== null ? enabledPlugins : '—'}</span>
                <ChevronDownIcon className="chev" aria-hidden="true" />
              </button>
              {expanded === 'plugins' ? (
                <div className="panel-expand">
                  {pluginChatReady ? (
                    <>
                      <p>
                        {enabledPlugins === 0
                          ? t('details.pluginsNone')
                          : t('details.pluginsCount', {
                              enabled: enabledPlugins ?? 0,
                              total: pluginRows.length,
                            })}
                      </p>
                      <p className="hint">
                        {isE2ee ? t('details.pluginsE2ee') : t('details.pluginsHint')}
                      </p>
                    </>
                  ) : pluginChatError ? (
                    <>
                      <p>{t('details.pluginsError')}</p>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => chat && void pluginsStore.loadChat(chat.id, true)}
                      >
                        {t('details.pluginsRetry')}
                      </button>
                    </>
                  ) : (
                    <p>{t('details.pluginsLoading')}</p>
                  )}
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => onNavigate('plugins')}
                    title={isE2ee ? t('plugins.e2eeChat') : undefined}
                  >
                    <PlugIcon aria-hidden="true" />
                    {t('details.openPlugins')}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {pollsEnabled ? (
            <>
              <button
                type="button"
                className={`panel-row${expanded === 'polls' ? ' is-open' : ''}`}
                aria-expanded={expanded === 'polls'}
                onClick={() => toggle('polls')}
              >
                <PollIcon aria-hidden="true" />
                <span>{t('pluginActions.pollsTitle')}</span>
                <span className="count">{pollCount !== null ? pollCount : '—'}</span>
                <ChevronDownIcon className="chev" aria-hidden="true" />
              </button>
              {expanded === 'polls' ? (
                <div className="panel-expand panel-expand--plugin">
                  {chat ? <PollPanel chatId={chat.id} /> : null}
                </div>
              ) : null}
            </>
          ) : null}

          {tasksEnabled ? (
            <>
              <button
                type="button"
                className={`panel-row${expanded === 'tasks' ? ' is-open' : ''}`}
                aria-expanded={expanded === 'tasks'}
                onClick={() => toggle('tasks')}
              >
                <TaskIcon aria-hidden="true" />
                <span>{t('pluginActions.tasksTitle')}</span>
                <span className="count">{openTaskCount !== null ? openTaskCount : '—'}</span>
                <ChevronDownIcon className="chev" aria-hidden="true" />
              </button>
              {expanded === 'tasks' ? (
                <div className="panel-expand panel-expand--plugin">
                  {chat ? <TaskPanel chatId={chat.id} /> : null}
                </div>
              ) : null}
            </>
          ) : null}

          <button
            type="button"
            className={`panel-row${attachmentsOpen ? ' is-open' : ''}`}
            aria-expanded={attachmentsOpen}
            onClick={() => toggle('media')}
          >
            <ImageIcon aria-hidden="true" />
            <span>{isDirect ? t('details.sharedFiles') : t('details.attachments')}</span>
            <span className="count">{mediaTotal}</span>
            <ChevronDownIcon className="chev" aria-hidden="true" />
          </button>
          {attachmentsOpen ? (
            <div className="panel-expand">
              {isE2ee ? (
                <p>{t('details.attachmentsUnavailable')}</p>
              ) : slice?.status === 'loading' && !loadedAttachments ? (
                <p>{t('details.mediaLoading')}</p>
              ) : !loadedAttachments ? (
                <p>{t('details.noMedia')}</p>
              ) : (
                <>
                  <div className="media-grid">
                    {media.slice(0, 4).map((item, index) => (
                      <div className={`media-tile media-tile--${item.kind}`} key={item.id}>
                        <MediaPreview item={item} />
                        <span className="media-tile__label">{item.ext}</span>
                        {index === 3 && mediaTotal > 4 ? (
                          <span className="media-tile__more">+{mediaTotal - 4}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <p className="hint">{t('details.attachmentsHint')}</p>
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="panel-sep" />

        {isDirect ? (
          <div className="panel-foot">
            {!isE2ee ? (
              <button
                type="button"
                className="danger-row"
                disabled={!onStartCall || callDisabledReason !== null}
                onClick={() => onStartCall?.(false)}
                title={callDisabledReason ?? t('details.call')}
              >
                <PhoneIcon aria-hidden="true" />
                {t('details.call')}
              </button>
            ) : null}
            <button type="button" className="danger-row" disabled title={t('details.blockHint')}>
              <FlagIcon aria-hidden="true" />
              {t('details.block')}
            </button>
          </div>
        ) : (
          <div className="panel-foot">
            {!isE2ee ? (
              <button
                type="button"
                className="danger-row"
                disabled={!onStartCall || callDisabledReason !== null}
                onClick={() => onStartCall?.(false)}
                title={callDisabledReason ?? t('details.call')}
              >
                <PhoneIcon aria-hidden="true" />
                {t('details.call')}
              </button>
            ) : null}
            <button type="button" className="danger-row" disabled title={t('details.leaveHint')}>
              <LogoutIcon aria-hidden="true" />
              {t('details.leave')}
            </button>
          </div>
        )}
      </div>

      <NotificationPreferencesDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
    </aside>
  );
}
