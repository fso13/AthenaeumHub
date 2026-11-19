import { useEffect, useMemo } from 'react';
import type { ApiMessage } from '../../api/types';
import { chatDisplayName } from '../../domain/chatLabel';
import { formatBytes } from '../../files/format';
import { t } from '../../i18n/ru';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import type { AppView } from '../../router/views';
import { Avatar } from '../Avatar';
import {
  FolderIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  PeopleIcon,
  PlayIcon,
  ShieldIcon,
  UserPlusIcon,
} from '../Icons';
import { PageShell } from './PageShell';
import {
  collectFiles,
  fileName,
  fileKind,
  fileKindLabel,
  loadedMessageCount,
  onlineMemberCount,
  pluralRu,
  securityModeLabel,
  storageLimit,
  storagePercent,
  storageUsed,
  tariffLabel,
  todayLabel,
  totalUnread,
  type FileEntry,
} from './pageData';

interface OverviewPageProps {
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
  onNavigate: (view: AppView) => void;
  onOpenMembers: () => void;
}

interface ActivityItem {
  message: ApiMessage;
  chatName: string;
  text: string;
}

function shortName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? '';
}

function truncated(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 96 ? `${text.slice(0, 95)}…` : text;
}

function activityFromState(state: ReturnType<typeof useChatState>): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const chat of state.chats) {
    const slice = state.slices[chat.id];
    if (!slice) continue;
    for (const message of slice.messages) {
      if (message.deleted_at || message.type === 'SYSTEM') continue;
      const text = (slice.e2ee[message.id]?.text ?? message.text ?? '').trim();
      if (!text) continue;
      items.push({
        message,
        chatName: chatDisplayName(chat, state.workspaceMembers.items),
        text,
      });
    }
  }
  return items
    .sort((left, right) => right.message.created_at.localeCompare(left.message.created_at))
    .slice(0, 5);
}

function attachmentIcon(entry: FileEntry) {
  const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
  if (kind === 'video') return <PlayIcon />;
  if (kind === 'image') return <ImageIcon />;
  if (kind === 'audio') return <PlayIcon />;
  return <FolderIcon />;
}

/** D1 UX fidelity 2: workspace dashboard built only from already-loaded APIs. */
export function OverviewPage({ onBack, onOpenChat, onNavigate, onOpenMembers }: OverviewPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const user = state.user ?? state.session?.user ?? null;
  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const mode =
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    ('MANAGED' as const);
  const managed = mode !== 'E2EE';
  const members = state.workspaceMembers;
  const membersReady = members.status === 'ready';
  const limits = state.chatLimits;
  const files = useMemo(() => collectFiles(state), [state]);
  const messages = useMemo(() => loadedMessageCount(state), [state]);
  const online = useMemo(() => {
    const count = onlineMemberCount(state);
    return membersReady ? Math.min(count, members.items.length) : count;
  }, [members.items.length, membersReady, state]);
  const unread = totalUnread(state);
  const percent = storagePercent(limits);

  const quickChats = useMemo(
    () =>
      [...state.chats]
        .sort((left, right) =>
          (right.last_message_at ?? '').localeCompare(left.last_message_at ?? ''),
        )
        .slice(0, 4),
    [state.chats],
  );
  const activity = useMemo(() => activityFromState(state), [state]);
  const recentFiles = useMemo(() => files.slice(0, 4), [files]);
  const primaryChat = state.chats.find((chat) => chat.type === 'GROUP') ?? state.chats[0] ?? null;
  const primaryName = primaryChat
    ? chatDisplayName(primaryChat, members.items)
    : t('overview.allChats');

  useEffect(() => {
    if (!state.activeWorkspaceId && !state.session) return;
    if (members.status === 'idle') void store.loadWorkspaceMembers();
  }, [members.status, state.activeWorkspaceId, state.session, store]);

  const firstName = shortName(user?.display_name) || t('overview.greetingFallbackName');

  return (
    <PageShell
      title={t('overview.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(mode)}`}
      onBack={onBack}
      actions={
        <>
          <button
            type="button"
            className="btn"
            aria-label={t('overview.filesAction')}
            onClick={() => onNavigate('files')}
          >
            <FolderIcon aria-hidden="true" />
            <span>{t('overview.filesAction')}</span>
          </button>
          <button
            type="button"
            className="btn btn--accent"
            aria-label={t('overview.invite')}
            onClick={onOpenMembers}
          >
            <UserPlusIcon aria-hidden="true" />
            <span>{t('overview.invite')}</span>
          </button>
        </>
      }
    >
      <div className="ov-hero">
        <div>
          <p className="page-eyebrow">{todayLabel()}</p>
          <h2 className="ov-title">{t('overview.greeting', { name: firstName })}</h2>
          <p className="ov-sub">
            {t('overview.summaryParts', {
              workspace: workspaceName,
              members: membersReady
                ? `${members.items.length} ${pluralRu(
                    members.items.length,
                    'участник',
                    'участника',
                    'участников',
                  )}`
                : '—',
              chats: `${state.chats.length} ${pluralRu(
                state.chats.length,
                'чат',
                'чата',
                'чатов',
              )}`,
              files: `${files.length} ${pluralRu(files.length, 'файл', 'файла', 'файлов')}`,
            })}
          </p>
        </div>
        <div className="ov-actions">
          <button
            type="button"
            className="btn"
            disabled={!primaryChat}
            onClick={() => primaryChat && onOpenChat(primaryChat.id)}
          >
            <HashIcon aria-hidden="true" />
            <span>
              {t('overview.openChat', {
                chat: primaryName.replace(/[«»]/g, '').trim(),
              })}
            </span>
          </button>
        </div>
      </div>

      <section className="stat-grid" aria-label={t('overview.metrics')}>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <HashIcon />
          </span>
          <div>
            <b>{messages}</b>
            <span>{t('overview.metric.messages')}</span>
          </div>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <FolderIcon />
          </span>
          <div>
            <b>{files.length}</b>
            <span>{t('overview.metric.files')}</span>
          </div>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <PeopleIcon />
          </span>
          <div>
            <b>{membersReady ? members.items.length : '—'}</b>
            <span>
              {membersReady
                ? t('overview.metric.members', {
                    noun: pluralRu(members.items.length, 'участник', 'участника', 'участников'),
                    online,
                  })
                : t('overview.metric.membersLoading')}
            </span>
          </div>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <ShieldIcon />
          </span>
          <div>
            <b>—</b>
            <span>{managed ? t('overview.metric.dlp') : t('overview.metric.keys')}</span>
          </div>
          <small>{t('overview.metric.noData')}</small>
        </article>
      </section>

      <div className="ov-grid">
        <section className="card" aria-labelledby="overview-activity">
          <div className="card-head">
            <h2 className="card-title" id="overview-activity">
              {t('overview.activity')}
            </h2>
            <button type="button" className="card-link" onClick={() => onNavigate('security')}>
              {t('overview.allEvents')}
            </button>
          </div>
          {activity.length === 0 ? (
            <p className="card-empty">{t('overview.noActivity')}</p>
          ) : (
            <div className="activity">
              {activity.map((item) => (
                <div className="activity-row" key={item.message.id}>
                  <Avatar
                    name={item.message.sender_display_name}
                    seed={item.message.sender_id ?? item.message.id}
                    size="xs"
                  />
                  <div className="activity-text">
                    <b>{item.message.sender_display_name?.trim() || t('chat.unknownAuthor')}</b>{' '}
                    {truncated(item.text)}
                  </div>
                  <time className="activity-time" dateTime={item.message.created_at}>
                    {new Intl.DateTimeFormat('ru-RU', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(item.message.created_at))}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="overview-quick">
          <div className="card-head">
            <h2 className="card-title" id="overview-quick">
              {t('overview.quickAccess')}
            </h2>
            <button type="button" className="card-link" onClick={onBack}>
              {t('overview.allChats')}
              {unread > 0 ? <span className="visually-hidden"> · {unread}</span> : null}
            </button>
          </div>
          {quickChats.length === 0 ? (
            <p className="card-empty">{t('overview.noChats')}</p>
          ) : (
            <div className="quick-list">
              {quickChats.map((chat) => {
                const label = chatDisplayName(chat, members.items);
                const badge = chat.unread_count > 99 ? '99+' : chat.unread_count;
                const hasBadge = chat.unread_count > 0;
                return (
                  <button
                    type="button"
                    className="quick-row"
                    key={chat.id}
                    onClick={() => onOpenChat(chat.id)}
                  >
                    {chat.type === 'DIRECT' ? (
                      <Avatar name={label} seed={chat.id} size="xs" />
                    ) : (
                      <span className="channel-ic" aria-hidden="true">
                        <HashIcon />
                      </span>
                    )}
                    <span className="name">{label}</span>
                    {hasBadge ? (
                      <span className="badge" aria-hidden="true">
                        {badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <div className="ov-grid ov-grid--3">
        <section className="card" aria-labelledby="overview-storage">
          <div className="card-head">
            <h2 className="card-title" id="overview-storage">
              {t('overview.storage')}
            </h2>
            <span className="chip">{limits ? tariffLabel(limits.tariff) : '—'}</span>
          </div>
          {limits ? (
            <>
              <div
                className="meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t('overview.storageUsage', { percent })}
              >
                <i style={{ width: `${percent}%` }} />
              </div>
              <div className="meter-row">
                <span>
                  {t('limits.usage', {
                    used: storageUsed(limits),
                    limit: storageLimit(limits),
                  })}
                </span>
                <span>{t('limits.percent', { percent })}</span>
              </div>
              <div className="limits">
                <span className="limit">
                  {t('overview.storageLimitGuest', {
                    size: formatBytes(limits.guest_file_bytes),
                  })}
                </span>
                <span className="limit is-current">
                  {t('overview.storageLimitFile', { size: formatBytes(limits.max_file_bytes) })}
                </span>
                <span className="limit">
                  {t('overview.storageLimitCount', { count: limits.max_attachments })}
                </span>
                <span className="limit">
                  {t('overview.storageLimitChats', {
                    used: limits.chats_used,
                    limit: limits.max_chats_per_user,
                  })}
                </span>
              </div>
            </>
          ) : (
            <p className="card-empty">{t('overview.limitsUnavailable')}</p>
          )}
        </section>

        <section className="card" aria-labelledby="overview-security">
          <div className="card-head">
            <h2 className="card-title" id="overview-security">
              {managed ? t('overview.controlManaged') : t('overview.controlE2ee')}
            </h2>
            <span className={`chip${managed ? '' : ' chip--accent'}`}>
              {managed ? 'DLP' : 'E2EE'}
            </span>
          </div>
          <p className="pane-sub">
            {managed ? t('overview.controlManagedText') : t('overview.controlE2eeText')}
          </p>
          <button type="button" className="btn btn--sm" onClick={() => onNavigate('security')}>
            <ShieldIcon aria-hidden="true" />
            {t('overview.securityMore')}
          </button>
        </section>

        <section className="card" aria-labelledby="overview-team">
          <div className="card-head">
            <h2 className="card-title" id="overview-team">
              {t('overview.team')}
            </h2>
            <span className="muted">
              {membersReady ? t('overview.teamOnline', { count: online }) : '—'}
            </span>
          </div>
          {membersReady && members.items.length > 0 ? (
            <div className="team-row">
              {members.items.slice(0, 4).map((member) => (
                <Avatar
                  key={member.user_id}
                  name={member.display_name}
                  seed={member.user_id}
                  size="xs"
                />
              ))}
              {members.items.length > 4 ? (
                <span className="team-count">
                  {t('overview.teamMore', { count: members.items.length - 4 })}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="card-empty">
              {members.status === 'loading'
                ? t('common.loading')
                : members.status === 'error'
                  ? t('overview.membersError')
                  : t('overview.metric.membersLoading')}
            </p>
          )}
          <p className="pane-sub">{t('overview.teamHint')}</p>
          <button type="button" className="btn btn--sm" onClick={onOpenMembers}>
            <LinkIcon aria-hidden="true" />
            {t('overview.invite')}
          </button>
        </section>
      </div>

      <section className="card ov-recent" aria-labelledby="overview-recent">
        <div className="card-head">
          <h2 className="card-title" id="overview-recent">
            {t('overview.recentFiles')}
          </h2>
          <button type="button" className="card-link" onClick={() => onNavigate('files')}>
            {t('overview.allFiles')}
          </button>
        </div>
        {recentFiles.length === 0 ? (
          <p className="card-empty">{t('overview.noFiles')}</p>
        ) : (
          <div className="recent-media">
            {recentFiles.map((entry) => {
              const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
              const artwork = entry.attachment.media?.artwork_url;
              return (
                <button
                  type="button"
                  className="recent-item"
                  key={entry.attachment.id}
                  onClick={() => onNavigate('files')}
                >
                  <span className={`recent-thumb recent-thumb--${kind}`} aria-hidden="true">
                    {artwork ? <img src={artwork} alt="" loading="lazy" /> : attachmentIcon(entry)}
                  </span>
                  <span className="recent-name">
                    <b>{fileName(entry.attachment)}</b>
                    <small>
                      {t('overview.filesMeta', {
                        kind: fileKindLabel(kind),
                        chat: entry.chatName,
                      })}{' '}
                      · {formatBytes(entry.attachment.size_bytes)}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {members.status === 'error' ? (
        <p className="pg-inline-error" role="status">
          {t('overview.membersError')}
        </p>
      ) : null}
    </PageShell>
  );
}
