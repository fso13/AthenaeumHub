import { useEffect } from 'react';
import { chatDisplayName } from '../../domain/chatLabel';
import { formatBytes } from '../../files/format';
import { t } from '../../i18n/ru';
import { useChatState, useChatStore } from '../../store/ChatProvider';
import type { AppView } from '../../router/views';
import { Avatar } from '../Avatar';
import { FolderIcon, PeopleIcon, ShieldIcon, ChatIcon } from '../Icons';
import { PageShell } from './PageShell';
import {
  collectFiles,
  fileName,
  fileKindLabel,
  fileKind,
  roleLabel,
  storagePercent,
  storageUsed,
  storageLimit,
  totalUnread,
} from './pageData';

interface OverviewPageProps {
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
  onNavigate: (view: AppView) => void;
  onOpenMembers: () => void;
}

/** D1-FE1: workspace dashboard built only from the already-loaded APIs. */
export function OverviewPage({ onBack, onOpenChat, onNavigate, onOpenMembers }: OverviewPageProps) {
  const store = useChatStore();
  const state = useChatState();
  const user = state.user ?? state.session?.user ?? null;
  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const members = state.workspaceMembers;
  const membersReady = members.status === 'ready';
  const limits = state.chatLimits;
  const percent = storagePercent(limits);
  const unread = totalUnread(state);
  const quickChats = [...state.chats]
    .sort((left, right) => (right.last_message_at ?? '').localeCompare(left.last_message_at ?? ''))
    .slice(0, 5);
  const files = collectFiles(state).slice(0, 6);
  const loading =
    state.sessionStatus === 'idle' ||
    state.sessionStatus === 'loading' ||
    state.chatLimitsStatus === 'loading';

  useEffect(() => {
    if (!state.activeWorkspaceId && !state.session) return;
    void store.loadWorkspaceMembers();
  }, [state.activeWorkspaceId, state.session, store]);

  return (
    <PageShell
      title={t('overview.title')}
      subtitle={t('overview.subtitle', { workspace: workspaceName })}
      onBack={onBack}
      actions={
        <button
          type="button"
          className="button button--secondary"
          onClick={() => onNavigate('files')}
        >
          <FolderIcon aria-hidden="true" />
          {t('overview.openFiles')}
        </button>
      }
    >
      <p className="page__greeting">{t('overview.welcome', { name: user?.display_name ?? '—' })}</p>

      {loading ? (
        <div className="page__skeleton" role="status" aria-label={t('common.loading')}>
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
        </div>
      ) : null}

      <section className="stat-grid" aria-label={t('overview.metrics')}>
        <article className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">
            <ChatIcon />
          </span>
          <span className="stat-card__value">{state.chats.length}</span>
          <span className="stat-card__label">{t('overview.metric.chats')}</span>
        </article>
        <article className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">
            <PeopleIcon />
          </span>
          <span className="stat-card__value">{membersReady ? members.items.length : '—'}</span>
          <span className="stat-card__label">{t('overview.metric.members')}</span>
        </article>
        <article className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">
            <ChatIcon />
          </span>
          <span className="stat-card__value">{unread}</span>
          <span className="stat-card__label">{t('overview.metric.unread')}</span>
        </article>
        <article className="stat-card">
          <span className="stat-card__icon" aria-hidden="true">
            <ShieldIcon />
          </span>
          <span className="stat-card__value">{roleLabel(state.activeWorkspace?.role ?? null)}</span>
          <span className="stat-card__label">{t('overview.metric.role')}</span>
        </article>
      </section>

      <div className="page-grid">
        <section className="page-card" aria-labelledby="overview-storage">
          <header className="page-card__head">
            <h2 className="page-card__title" id="overview-storage">
              {t('overview.storage')}
            </h2>
            <span className="page-card__meta">
              {limits
                ? t('limits.usage', { used: storageUsed(limits), limit: storageLimit(limits) })
                : '—'}
            </span>
          </header>
          <div
            className="storage-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('overview.storageUsage', { percent })}
          >
            <span className="storage-bar__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="page-card__hint">
            {limits
              ? t('overview.storageDetails', {
                  file: formatBytes(limits.max_file_bytes),
                  count: limits.max_attachments,
                })
              : t('overview.limitsUnavailable')}
          </p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onNavigate('files')}
          >
            {t('overview.storageMore')}
          </button>
        </section>

        <section className="page-card" aria-labelledby="overview-quick">
          <header className="page-card__head">
            <h2 className="page-card__title" id="overview-quick">
              {t('overview.quickChats')}
            </h2>
          </header>
          {quickChats.length === 0 ? (
            <p className="page-card__empty">{t('overview.noChats')}</p>
          ) : (
            <ul className="quick-list">
              {quickChats.map((chat) => {
                const label = chatDisplayName(chat, members.items);
                return (
                  <li key={chat.id}>
                    <button
                      type="button"
                      className="quick-list__item"
                      onClick={() => onOpenChat(chat.id)}
                    >
                      <Avatar name={label} seed={chat.id} size="md" />
                      <span className="quick-list__name">{label}</span>
                      {chat.unread_count > 0 ? (
                        <span className="unread-badge" aria-hidden="true">
                          {chat.unread_count > 99 ? '99+' : chat.unread_count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="page-card" aria-labelledby="overview-security">
          <header className="page-card__head">
            <h2 className="page-card__title" id="overview-security">
              {t('overview.security')}
            </h2>
          </header>
          <p className="security-chip">
            <ShieldIcon aria-hidden="true" />
            {t('overview.securityManaged')}
          </p>
          <p className="page-card__hint">{t('overview.securityHint')}</p>
          <div className="page-card__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onNavigate('security')}
            >
              {t('overview.securityMore')}
            </button>
            <button type="button" className="button button--secondary" onClick={onOpenMembers}>
              <PeopleIcon aria-hidden="true" />
              {t('members.open')}
            </button>
          </div>
        </section>

        <section className="page-card" aria-labelledby="overview-recent">
          <header className="page-card__head">
            <h2 className="page-card__title" id="overview-recent">
              {t('overview.recentFiles')}
            </h2>
            <button type="button" className="link-button" onClick={() => onNavigate('files')}>
              {t('overview.allFiles')}
            </button>
          </header>
          {files.length === 0 ? (
            <p className="page-card__empty">{t('overview.noFiles')}</p>
          ) : (
            <ul className="recent-files">
              {files.map((entry) => (
                <li key={entry.attachment.id} className="recent-files__item">
                  <span className="recent-files__kind">
                    {fileKindLabel(fileKind(entry.attachment.mime_type, entry.attachment.filename))}
                  </span>
                  <span className="recent-files__name">{fileName(entry.attachment)}</span>
                  <span className="recent-files__size">
                    {formatBytes(entry.attachment.size_bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {members.status === 'error' ? (
        <p className="page__inline-error" role="status">
          {t('overview.membersError')}
        </p>
      ) : null}
    </PageShell>
  );
}
