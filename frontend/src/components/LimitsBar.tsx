import type { ApiError } from '../api/problem';
import type { WorkspaceLimits, WorkspaceRole } from '../api/types';
import { formatBytes, formatPercent } from '../files/format';
import {
  effectiveMaxFileBytes,
  limitState,
  maxAttachmentCount,
  usageCommitted,
  type LimitWarning,
} from '../files/limits';
import { t, type MessageKey } from '../i18n/ru';
import { RefreshIcon } from './Icons';

const WARNING_KEY: Record<Exclude<LimitWarning, 'ok'>, MessageKey> = {
  warning: 'limits.warning80',
  critical: 'limits.warning95',
  full: 'limits.warning100',
};

export interface LimitsBarProps {
  limits: WorkspaceLimits | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: ApiError | null;
  role: WorkspaceRole | null;
  onRetry: () => void;
}

export function LimitsBar({ limits, status, error, role, onRetry }: LimitsBarProps) {
  if (!limits) {
    if (status === 'error') {
      return (
        <div className="limits-bar limits-bar--error" role="status">
          <span>{t('files.limitsError')}</span>
          <button type="button" className="button button--small" onClick={onRetry}>
            <RefreshIcon aria-hidden="true" />
            {t('limits.retry')}
          </button>
        </div>
      );
    }
    return (
      <div className="limits-bar limits-bar--loading" role="status" aria-busy="true">
        {t('files.loadingLimits')}
      </div>
    );
  }

  const state = limitState(limits);
  const committed = usageCommitted(limits.usage);
  const effectiveMax = effectiveMaxFileBytes(limits, role) ?? limits.max_file_bytes;
  const warningText = state.warning === 'ok' ? null : t(WARNING_KEY[state.warning]);

  return (
    <section className="limits-bar" aria-label={t('limits.title')}>
      <div className="limits-bar__head">
        <span className="limits-bar__title">{t('limits.title')}</span>
        <span className="limits-bar__usage">
          {t('limits.usage', {
            used: formatBytes(committed),
            limit: formatBytes(state.limit),
          })}{' '}
          · {formatPercent(state.ratio)}
        </span>
      </div>

      <div
        className="limits-bar__track"
        role="progressbar"
        aria-label={t('limits.title')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.percent}
        aria-valuetext={formatPercent(state.ratio)}
        data-warning={state.warning}
      >
        <span className="limits-bar__fill" style={{ width: `${state.percent}%` }} />
      </div>

      <div className="limits-bar__meta">
        <span>{t('limits.maxFile', { size: formatBytes(effectiveMax) })}</span>
        <span>{t('limits.maxAttachments', { count: maxAttachmentCount(limits) })}</span>
        {role === 'GUEST' ? (
          <span>{t('limits.guest', { size: formatBytes(limits.guest_file_bytes) })}</span>
        ) : null}
        {limits.usage.reserved > 0 ? (
          <span>{t('limits.reserved', { size: formatBytes(limits.usage.reserved) })}</span>
        ) : null}
      </div>

      {warningText ? (
        <p
          className={`limits-bar__warning limits-bar__warning--${state.warning}`}
          role={state.warning === 'full' ? 'alert' : 'status'}
        >
          {warningText}
        </p>
      ) : null}

      {status === 'error' && error ? (
        <div className="limits-bar__refresh" role="status">
          <span>{t('files.limitsError')}</span>
          <button type="button" className="button button--small" onClick={onRetry}>
            <RefreshIcon aria-hidden="true" />
            {t('limits.retry')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
