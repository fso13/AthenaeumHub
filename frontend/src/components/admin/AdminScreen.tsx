import { useEffect, useRef, type KeyboardEvent } from 'react';
import { t } from '../../i18n/ru';
import { useLocation, useNavigate } from '../../router/router';
import {
  useAdminDirectoryState,
  useChatState,
  useOpsState,
  useOpsStore,
} from '../../store/ChatProvider';
import { AdminForbiddenScreen } from '../auth/AuthStatusScreens';
import { AdminAuditSection } from './AdminAuditSection';
import { AdminChatsSection } from './AdminChatsSection';
import { AdminOverviewSection } from './AdminOverviewSection';
import { AdminSettingsSection } from './AdminSettingsSection';
import { AdminStorageSection } from './AdminStorageSection';
import { AdminUsersSection } from './AdminUsersSection';
import { ADMIN_TABS, adminTabFromLocation, adminTabPath, type AdminTab } from './tabs';

interface AdminScreenProps {
  onBackToChats: () => void;
  onOpenSetup: () => void;
  onLogout: () => void;
}

/**
 * `/admin` (R-05, FR-ADM-10..14). UX only: every request is protected by the
 * server-side `PlatformAdminGuard`, and the screen surfaces aggregate metadata
 * only — never E2EE content, message text, filenames or file bytes.
 *
 * Sections are tabs (`?tab=users|chats|audit|storage|settings`), so the address bar
 * is deep-linkable and the browser Back button returns to the previous section.
 */
export function AdminScreen({ onBackToChats, onOpenSetup, onLogout }: AdminScreenProps) {
  const store = useOpsStore();
  const ops = useOpsState();
  const chat = useChatState();
  const directory = useAdminDirectoryState();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = adminTabFromLocation(location);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Overview + settings are loaded once per admin session; directory sections
    // load their own pages when mounted and cache them in the directory store.
    void store.loadAdmin();
  }, [store]);

  const setupRequired =
    ops.setupStatus?.setup_required ?? (ops.settings ? !ops.settings.setup_completed : false);

  // A stale `/me` flag must not keep the surface alive: any directory 403 is
  // treated exactly like the settings/overview 403 handled by App.
  const directoryForbidden =
    directory.users.error?.status === 403 ||
    directory.chats.error?.status === 403 ||
    directory.audit.error?.status === 403 ||
    directory.storage.error?.status === 403;

  if (directoryForbidden) {
    return <AdminForbiddenScreen onBack={onBackToChats} onLogout={onLogout} />;
  }

  const selectTab = (next: AdminTab) => {
    if (next === tab) return;
    navigate(adminTabPath(next));
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % ADMIN_TABS.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = ADMIN_TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = ADMIN_TABS[nextIndex];
    if (!next) return;
    selectTab(next.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <main className="admin-shell" aria-labelledby="admin-title">
      <header className="admin-shell__bar">
        <div className="admin-shell__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--real">{t('admin.title')}</span>
        </div>
        <div className="admin-shell__actions">
          <button type="button" className="button button--secondary" onClick={onBackToChats}>
            {t('admin.backToChats')}
          </button>
          <button type="button" className="button button--secondary" onClick={onLogout}>
            {t('auth.logout')}
          </button>
        </div>
      </header>

      <div className="admin-page">
        <section className="admin-hero" aria-labelledby="admin-title">
          <p className="admin-hero__eyebrow">pickle · managed</p>
          <h1 className="admin-hero__title" id="admin-title">
            {t('admin.title')}
          </h1>
          <p className="admin-hero__lead">{t('admin.lead')}</p>
          <p className="admin-hero__meta">
            {t('admin.setupStatus')}:{' '}
            <span
              className={`admin-chip${setupRequired ? ' admin-chip--warning' : ' admin-chip--ok'}`}
              role="status"
            >
              {t(setupRequired ? 'admin.setupRequired' : 'admin.setupCompleted')}
            </span>
            {setupRequired ? (
              <button type="button" className="admin-inline-link" onClick={onOpenSetup}>
                {t('admin.continueSetup')}
              </button>
            ) : null}
            {chat.me ? (
              <span className="admin-hero__identity">
                {t('admin.signedInAs', { email: chat.me.user.email })}
              </span>
            ) : null}
          </p>
        </section>

        <div className="admin-tabs" role="tablist" aria-label={t('admin.nav.label')}>
          {ADMIN_TABS.map((definition, index) => {
            const selected = definition.id === tab;
            return (
              <button
                key={definition.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`admin-tab-${definition.id}`}
                className={`admin-tab${selected ? ' admin-tab--active' : ''}`}
                aria-selected={selected}
                aria-controls="admin-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(definition.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {t(definition.label)}
              </button>
            );
          })}
        </div>

        <div
          className="admin-panel"
          role="tabpanel"
          id="admin-panel"
          aria-labelledby={`admin-tab-${tab}`}
          key={tab}
        >
          {tab === 'overview' ? <AdminOverviewSection onOpenTab={selectTab} /> : null}
          {tab === 'users' ? <AdminUsersSection /> : null}
          {tab === 'chats' ? <AdminChatsSection /> : null}
          {tab === 'audit' ? <AdminAuditSection /> : null}
          {tab === 'storage' ? <AdminStorageSection /> : null}
          {tab === 'settings' ? <AdminSettingsSection /> : null}
        </div>
      </div>
    </main>
  );
}
