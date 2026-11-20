import { useEffect, useMemo } from 'react';
import type { WorkspaceAuditEvent } from '../../api/types';
import { chatDisplayName } from '../../domain/chatLabel';
import { formatBytes } from '../../files/format';
import { t } from '../../i18n/ru';
import {
  useChatState,
  useChatStore,
  useWorkspaceOverviewState,
  useWorkspaceOverviewStore,
} from '../../store/ChatProvider';
import type { AppView } from '../../router/views';
import { Avatar } from '../Avatar';
import {
  FolderIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  PeopleIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  UserPlusIcon,
} from '../Icons';
import { PageShell } from './PageShell';
import {
  collectFiles,
  fileName,
  fileKind,
  fileKindLabel,
  onlineMemberCount,
  overviewActionLabel,
  overviewStoragePercent,
  pluralRu,
  securityModeLabel,
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

function shortName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? '';
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.max(0, Math.trunc(value)).toLocaleString('ru-RU');
}

function metricHint(status: string, readyText: string | null): string | null {
  if (readyText !== null) return readyText;
  return status === 'error' ? t('overview.metric.noData') : t('common.loading');
}

function activityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function attachmentIcon(entry: FileEntry) {
  const kind = fileKind(entry.attachment.mime_type, entry.attachment.filename);
  if (kind === 'video') return <PlayIcon />;
  if (kind === 'image') return <ImageIcon />;
  if (kind === 'audio') return <PlayIcon />;
  return <FolderIcon />;
}

/**
 * #84 workspace dashboard.
 *
 * Metrics, activity, team and storage come from `GET /workspaces/{id}/overview`
 * (counts/bytes plus at most five content-free audit rows). The page keeps the
 * existing navigation, quick chats and recent files; it never renders message
 * bodies, E2EE envelopes, filenames from the overview response, IPs or tokens.
 */
export function OverviewPage({ onBack, onOpenChat, onNavigate, onOpenMembers }: OverviewPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const overviewStore = useWorkspaceOverviewStore();
  const overviewState = useWorkspaceOverviewState();
  const overview = overviewState.data;
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
  const unread = totalUnread(state);
  const workspaceId = state.activeWorkspaceId ?? state.session?.workspace.id ?? null;

  const loading =
    overviewState.status === 'loading' ||
    (overview === null && overviewState.status === 'idle' && workspaceId !== null);
  const failed = overviewState.status === 'error';
  const overviewReady = overview !== null;

  useEffect(() => {
    if (!workspaceId) return;
    overviewStore.setWorkspace(workspaceId);
    void overviewStore.load();
  }, [overviewStore, workspaceId]);

  useEffect(() => {
    if (!state.activeWorkspaceId && !state.session) return;
    if (members.status === 'idle') void store.loadWorkspaceMembers();
  }, [members.status, state.activeWorkspaceId, state.session, store]);

  const quickChats = useMemo(
    () =>
      [...state.chats]
        .sort((left, right) =>
          (right.last_message_at ?? '').localeCompare(left.last_message_at ?? ''),
        )
        .slice(0, 4),
    [state.chats],
  );
  const recentFiles = useMemo(() => files.slice(0, 4), [files]);
  const primaryChat = state.chats.find((chat) => chat.type === 'GROUP') ?? state.chats[0] ?? null;
  const primaryName = primaryChat
    ? chatDisplayName(primaryChat, members.items)
    : t('overview.allChats');

  const firstName = shortName(user?.display_name) || t('overview.greetingFallbackName');

  const memberTotal = overview?.members.total ?? null;
  const online = overview?.members.online ?? null;
  const chatTotal = overview?.chats ?? null;
  const messageTotal = overview?.messages.total ?? null;
  const messages24 = overview?.messages.last_24h ?? null;
  const fileTotal = overview?.files.total ?? null;
  const dlpEvents = overview?.dlp.events_last_24h ?? null;
  const storageUsed = overview?.storage.used_bytes ?? null;
  const storageQuota = overview?.storage.quota_bytes ?? null;
  const storagePercentValue =
    overview === null ? 0 : overviewStoragePercent(overview.storage.used_bytes, storageQuota ?? 0);
  const activity = overview?.audit_recent ?? [];

  const localOnline = useMemo(() => {
    const value = onlineMemberCount(state);
    return membersReady ? Math.min(value, members.items.length) : value;
  }, [members.items.length, membersReady, state]);

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
            aria-label={t('overview.refresh')}
            onClick={() => void overviewStore.load(true)}
            disabled={loading}
          >
            <RefreshIcon aria-hidden="true" />
            <span>{loading ? t('common.loading') : t('overview.refresh')}</span>
          </button>
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
              members:
                memberTotal === null
                  ? '—'
                  : `${count(memberTotal)} ${pluralRu(
                      memberTotal,
                      'участник',
                      'участника',
                      'участников',
                    )}`,
              chats:
                chatTotal === null
                  ? '—'
                  : `${count(chatTotal)} ${pluralRu(chatTotal, 'чат', 'чата', 'чатов')}`,
              files:
                fileTotal === null
                  ? '—'
                  : `${count(fileTotal)} ${pluralRu(fileTotal, 'файл', 'файла', 'файлов')}`,
            })}
          </p>
          {overviewReady ? (
            <p className="muted">
              {t('overview.updatedAt', {
                time: activityTime(overview.generated_at),
              })}
            </p>
          ) : null}
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

      {loading ? (
        <p className="pg-footnote" role="status" aria-busy="true">
          {t('overview.loading')}
        </p>
      ) : null}

      {failed ? (
        <div className="pg-inline-error" role="alert">
          <div>
            <p>{t('overview.loadError')}</p>
            {overviewState.error ? (
              <p className="pg-footnote">
                {overviewState.error.status > 0
                  ? `HTTP ${overviewState.error.status} · ${overviewState.error.code}`
                  : overviewState.error.code}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void overviewStore.load(true)}
          >
            {t('overview.retry')}
          </button>
        </div>
      ) : null}

      <section className="stat-grid" aria-label={t('overview.metrics')}>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <HashIcon />
          </span>
          <div>
            <b>{count(messageTotal)}</b>
            <span>{t('overview.metric.messages')}</span>
          </div>
          <small>
            {metricHint(
              overviewState.status,
              overviewReady
                ? t('overview.metric.messagesRecent', { count: messages24 ?? 0 })
                : null,
            )}
          </small>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <FolderIcon />
          </span>
          <div>
            <b>{count(fileTotal)}</b>
            <span>{t('overview.metric.files')}</span>
          </div>
          <small>
            {metricHint(
              overviewState.status,
              overviewReady && overview
                ? t('overview.metric.filesUsed', {
                    size: formatBytes(overview.files.used_bytes),
                  })
                : null,
            )}
          </small>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <PeopleIcon />
          </span>
          <div>
            <b>{count(memberTotal)}</b>
            <span>
              {memberTotal === null
                ? t('overview.metric.membersLoading')
                : t('overview.metric.members', {
                    noun: pluralRu(memberTotal, 'участник', 'участника', 'участников'),
                    online: online ?? 0,
                  })}
            </span>
          </div>
          <small>
            {metricHint(
              overviewState.status,
              overviewReady ? t('overview.metric.onlineNow', { count: online ?? 0 }) : null,
            )}
          </small>
        </article>
        <article className="stat">
          <span className="stat-ic" aria-hidden="true">
            <ShieldIcon />
          </span>
          <div>
            <b>{count(dlpEvents)}</b>
            <span>{managed ? t('overview.metric.dlp') : t('overview.metric.keys')}</span>
          </div>
          <small>
            {metricHint(overviewState.status, overviewReady ? t('overview.metric.lastDay') : null)}
          </small>
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
          {loading && !overviewReady ? (
            <p className="card-empty">{t('common.loading')}</p>
          ) : activity.length === 0 ? (
            <p className="card-empty">
              {failed ? t('overview.loadError') : t('overview.activityEmpty')}
            </p>
          ) : (
            <div className="activity">
              {activity.map((event: WorkspaceAuditEvent) => (
                <div className="activity-row" key={event.id}>
                  <span className="stat-ic" aria-hidden="true">
                    <ShieldIcon />
                  </span>
                  <div className="activity-text">
                    <b>{overviewActionLabel(event.action)}</b>
                    <span className="muted">
                      {event.actor_id
                        ? t('overview.activityActor', { id: event.actor_id.slice(0, 8) })
                        : t('overview.activitySystem')}
                    </span>
                  </div>
                  <time className="activity-time" dateTime={event.created_at}>
                    {activityTime(event.created_at)}
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
          {overviewReady && storageUsed !== null && storageQuota !== null ? (
            <>
              <div
                className="meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={storagePercentValue}
                aria-label={t('overview.storageUsage', { percent: storagePercentValue })}
              >
                <i style={{ width: `${storagePercentValue}%` }} />
              </div>
              <div className="meter-row">
                <span>
                  {t('overview.storageMeter', {
                    used: formatBytes(storageUsed),
                    limit: formatBytes(storageQuota),
                  })}
                </span>
                <span>{t('limits.percent', { percent: storagePercentValue })}</span>
              </div>
              <div className="limits">
                <span className="limit is-current">
                  {t('overview.storageFiles', {
                    total: count(fileTotal),
                    used: formatBytes(overview?.files.used_bytes ?? 0),
                    reserved: formatBytes(overview?.files.reserved_bytes ?? 0),
                  })}
                </span>
                {limits ? (
                  <>
                    <span className="limit">
                      {t('overview.storageLimitGuest', {
                        size: formatBytes(limits.guest_file_bytes),
                      })}
                    </span>
                    <span className="limit">
                      {t('overview.storageLimitFile', { size: formatBytes(limits.max_file_bytes) })}
                    </span>
                    <span className="limit">
                      {t('overview.storageLimitCount', { count: limits.max_attachments })}
                    </span>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <p className="card-empty">
              {failed ? t('overview.metric.noData') : t('common.loading')}
            </p>
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
          <p className="pane-sub">
            {t('overview.metric.dlp')}: <b>{count(dlpEvents)}</b>
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
              {overviewReady
                ? t('overview.teamOnlineLabel', { count: online ?? 0 })
                : failed
                  ? t('overview.metric.noData')
                  : '—'}
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
          <p className="pane-sub">
            {overviewReady
              ? t('overview.teamTotal', { count: count(memberTotal) })
              : failed
                ? t('overview.loadError')
                : t('common.loading')}
            {!overviewReady && membersReady && localOnline > 0
              ? ` · ${t('overview.teamOnline', { count: localOnline })}`
              : ''}
          </p>
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
