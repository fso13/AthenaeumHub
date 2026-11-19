import { t, type MessageKey } from '../../i18n/ru';
import { useChatState } from '../../store/ChatProvider';
import {
  ImageIcon,
  LockIcon,
  PlugIcon,
  PollIcon,
  ShieldIcon,
  StickerIcon,
  TaskIcon,
  TranslateIcon,
} from '../Icons';
import { PageShell } from './PageShell';
import { securityModeLabel } from './pageData';
import type { ReactNode } from 'react';

interface CatalogEntry {
  id: string;
  name: MessageKey;
  desc: MessageKey;
  icon: ReactNode;
  perms: ReadonlyArray<MessageKey>;
}

const CATALOG: ReadonlyArray<CatalogEntry> = [
  {
    id: 'poll',
    name: 'plugins.poll.name',
    desc: 'plugins.poll.desc',
    icon: <PollIcon />,
    perms: ['plugins.perms.messages', 'plugins.perms.members'],
  },
  {
    id: 'task',
    name: 'plugins.task.name',
    desc: 'plugins.task.desc',
    icon: <TaskIcon />,
    perms: ['plugins.perms.messages'],
  },
  {
    id: 'translate',
    name: 'plugins.translate.name',
    desc: 'plugins.translate.desc',
    icon: <TranslateIcon />,
    perms: ['plugins.perms.messages'],
  },
  {
    id: 'telegram',
    name: 'plugins.telegram.name',
    desc: 'plugins.telegram.desc',
    icon: <PlugIcon />,
    perms: ['plugins.perms.messages', 'plugins.perms.members', 'plugins.perms.webhooks'],
  },
  {
    id: 'dlp',
    name: 'plugins.dlp.name',
    desc: 'plugins.dlp.desc',
    icon: <ShieldIcon />,
    perms: ['plugins.perms.messages', 'plugins.perms.files'],
  },
  {
    id: 'stickers',
    name: 'plugins.stickers.name',
    desc: 'plugins.stickers.desc',
    icon: <StickerIcon />,
    perms: ['plugins.perms.messages'],
  },
];

interface SimplePageProps {
  onBack: () => void;
}

/**
 * D1 UX fidelity 2: the plugin catalog needs a server API that does not exist in
 * this contract. The page keeps the design's 2-column card grid but every card
 * is explicitly unavailable: no fake switches or permission state.
 */
export function PluginsPage({ onBack }: SimplePageProps) {
  const state = useChatState();
  const workspaceName =
    state.activeWorkspace?.name ?? state.session?.workspace.name ?? t('app.tagline');
  const mode =
    state.activeWorkspace?.security_mode ??
    state.session?.workspace.security_mode ??
    ('MANAGED' as const);
  const e2ee = mode === 'E2EE';

  return (
    <PageShell
      title={t('plugins.title')}
      eyebrow={`${workspaceName} · ${securityModeLabel(mode)}`}
      onBack={onBack}
      actions={
        <button
          type="button"
          className="btn"
          disabled
          aria-label={t('plugins.catalogShort')}
          title={t('plugins.emptyText')}
        >
          <PlugIcon aria-hidden="true" />
          <span>{t('plugins.catalogShort')}</span>
        </button>
      }
    >
      <section className="card pg-empty-banner" aria-labelledby="plugins-state">
        <span className="empty-panel__icon" aria-hidden="true">
          <PlugIcon />
        </span>
        <div>
          <h2 className="card-title" id="plugins-state">
            {t('plugins.catalogUnavailableTitle')}
          </h2>
          <p className="card-empty">{t('plugins.emptyText')}</p>
        </div>
        <span className="chip chip--accent">{t('plugins.unavailableShort')}</span>
      </section>

      <div className="plugin-grid">
        {CATALOG.map((entry) => (
          <article className="plugin-card card" key={entry.id} aria-disabled="true">
            <div className="plugin-head">
              <span className="plugin-ic" aria-hidden="true">
                {entry.icon}
              </span>
              <div>
                <h3>{t(entry.name)}</h3>
                <p>{t(entry.desc)}</p>
              </div>
            </div>
            <div className="plugin-foot">
              {entry.perms.map((perm) => (
                <span className="perm" key={perm}>
                  {t(perm)}
                </span>
              ))}
              <span className="mode-chip mode-chip--mock">{t('plugins.unavailableShort')}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="plugin-note">
        <LockIcon aria-hidden="true" />
        <span>{e2ee ? t('plugins.noteE2ee') : t('plugins.note')}</span>
      </div>

      <div className="plug-preview-note">
        <ImageIcon aria-hidden="true" />
        <span>{t('plugins.previewHint')}</span>
      </div>
    </PageShell>
  );
}
