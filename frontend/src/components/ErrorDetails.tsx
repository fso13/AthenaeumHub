import type { ApiError } from '../api/problem';
import { t } from '../i18n/ru';

/** Raw technical details are disclosed on demand (never shown to the user as primary copy). */
export function ErrorDetails({ error }: { error: ApiError | null }) {
  if (!error) return null;

  return (
    <details className="error-details">
      <summary>{t('common.details')}</summary>
      <dl className="error-details__list">
        <div>
          <dt>{t('message.code')}</dt>
          <dd>
            <code>{error.code}</code>
          </dd>
        </div>
        <div>
          <dt>{t('message.requestId')}</dt>
          <dd>
            <code>{error.requestId ?? '—'}</code>
          </dd>
        </div>
        {error.status > 0 ? (
          <div>
            <dt>{t('message.status')}</dt>
            <dd>
              <code>{error.status}</code>
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
