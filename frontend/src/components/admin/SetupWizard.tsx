import { useEffect } from 'react';
import { useNavigate } from '../../router/router';
import { t } from '../../i18n/ru';
import { useChatState, useOpsState, useOpsStore } from '../../store/ChatProvider';
import { AdminSettingsForm } from './AdminSettingsForm';

/**
 * `/setup` (R-03/FR-ADM-2..4). Only a platform admin reaches this screen; the
 * server enforces the flag on every `/admin/*` call. The final submit sends
 * `PATCH /admin/settings` with `complete_setup=true` and then opens `/admin`.
 */
export function SetupWizard({ onLogout }: { onLogout: () => void }) {
  const store = useOpsStore();
  const ops = useOpsState();
  const chat = useChatState();
  const navigate = useNavigate();

  useEffect(() => {
    void store.loadSettings();
  }, [store]);

  const handleSave = async (patch: Parameters<typeof store.saveSettings>[0], complete: boolean) => {
    const saved = await store.saveSettings(patch, complete);
    if (saved && complete) {
      navigate('/admin', { replace: true });
    }
    return saved !== null;
  };

  const settings = ops.settings;
  const loading = !settings && (ops.settingsStatus === 'idle' || ops.settingsStatus === 'loading');

  return (
    <main className="admin-shell" aria-labelledby="setup-title">
      <header className="admin-shell__bar">
        <div className="admin-shell__brand">
          <span className="brand__name">{t('app.name')}</span>
          <span className="mode-chip mode-chip--real">{t('setup.step.finish')}</span>
        </div>
        <button type="button" className="button button--secondary" onClick={onLogout}>
          {t('setup.logout')}
        </button>
      </header>

      <div className="admin-page admin-page--narrow">
        <section className="admin-hero" aria-labelledby="setup-title">
          <p className="admin-hero__eyebrow">
            {t('setup.step.smtp')} · {t('setup.step.business')}
          </p>
          <h1 className="admin-hero__title" id="setup-title">
            {t('setup.title')}
          </h1>
          <p className="admin-hero__lead">{t('setup.lead')}</p>
          <ol className="admin-steps" aria-label={t('setup.title')}>
            <li className="admin-steps__item admin-steps__item--active">
              <span className="admin-steps__index" aria-hidden="true">
                1
              </span>
              {t('setup.step.smtp')}
            </li>
            <li className="admin-steps__item admin-steps__item--active">
              <span className="admin-steps__index" aria-hidden="true">
                2
              </span>
              {t('setup.step.business')}
            </li>
            <li className="admin-steps__item">
              <span className="admin-steps__index" aria-hidden="true">
                3
              </span>
              {t('setup.step.finish')}
            </li>
          </ol>
        </section>

        <section className="admin-card" aria-label={t('admin.settingsSection')}>
          {loading ? (
            <p className="admin-state" role="status" aria-busy="true">
              {t('admin.settingsLoading')}
            </p>
          ) : null}

          {!settings && ops.settingsStatus === 'error' ? (
            <div className="admin-state admin-state--error" role="alert">
              <p>{t('admin.settingsError')}</p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void store.loadSettings(true)}
              >
                {t('admin.settingsRetry')}
              </button>
            </div>
          ) : null}

          {settings ? (
            <>
              <p className="admin-card__note">{t('setup.completeHint')}</p>
              <AdminSettingsForm
                mode="setup"
                settings={settings}
                saving={ops.saving}
                saveError={ops.saveError}
                testEmailStatus={ops.testEmailStatus}
                testEmailError={ops.testEmailError}
                testEmailTo={ops.testEmailTo}
                defaultTestEmail={chat.me?.user.email ?? ''}
                onSave={handleSave}
                onTestEmail={(to) => store.sendTestEmail(to)}
              />
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
