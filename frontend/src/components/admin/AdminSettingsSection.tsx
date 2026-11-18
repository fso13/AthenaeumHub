import { t } from '../../i18n/ru';
import { useChatState, useOpsState, useOpsStore } from '../../store/ChatProvider';
import { AdminSettingsForm } from './AdminSettingsForm';
import { formatDateTime } from './format';

/**
 * `/admin?tab=settings`: SMTP, business limits, test email and the audit note.
 * The SMTP password never enters the store — it lives only in the form state
 * until `PATCH /admin/settings` completes.
 */
export function AdminSettingsSection() {
  const store = useOpsStore();
  const ops = useOpsState();
  const chat = useChatState();
  const settings = ops.settings;
  const loading = !settings && (ops.settingsStatus === 'idle' || ops.settingsStatus === 'loading');
  const forbidden = ops.settingsError?.status === 403;

  const handleSave = async (patch: Parameters<typeof store.saveSettings>[0], complete: boolean) => {
    const saved = await store.saveSettings(patch, complete);
    if (saved && complete) {
      await store.loadAdmin(true);
    }
    return saved !== null;
  };

  return (
    <section className="admin-card admin-section" aria-labelledby="admin-settings-title">
      <div className="admin-card__head">
        <div>
          <h2 className="admin-card__title" id="admin-settings-title">
            {t('admin.settingsSection')}
          </h2>
          <p className="admin-card__lead">{t('admin.settings.lead')}</p>
        </div>
      </div>

      {loading ? (
        <p className="admin-state" role="status" aria-busy="true">
          {t('admin.settingsLoading')}
        </p>
      ) : null}

      {!settings && ops.settingsStatus === 'error' ? (
        <div className="admin-state admin-state--error" role="alert">
          <p>{forbidden ? t('admin.forbidden.text') : t('admin.settingsError')}</p>
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
        <AdminSettingsForm
          mode="admin"
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
      ) : null}

      <aside className="admin-audit" aria-label={t('admin.auditTitle')}>
        <h3 className="admin-audit__title">{t('admin.auditTitle')}</h3>
        <p className="admin-audit__text">{t('admin.auditText')}</p>
        {settings ? (
          <p className="admin-audit__meta">
            {t('admin.updatedAt', { time: formatDateTime(settings.updated_at) })}
            {settings.updated_by ? ` · ${t('admin.updatedBy', { id: settings.updated_by })}` : ''}
          </p>
        ) : null}
      </aside>
    </section>
  );
}
