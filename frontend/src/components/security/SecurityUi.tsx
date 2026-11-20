import type { ReactNode } from 'react';
import type { ApiError } from '../../api/problem';
import { t } from '../../i18n/ru';
import { ErrorDetails } from '../ErrorDetails';
import { RefreshIcon } from '../Icons';

/** Shared compact states for the P0-3 security cards (same design tokens). */

export function SectionLoading({ label }: { label: string }) {
  return (
    <p className="card-empty sec-status" role="status">
      {label}
    </p>
  );
}

interface SectionErrorProps {
  text: string;
  error: ApiError | null;
  onRetry: () => void;
  retryLabel?: string;
}

export function SectionError({ text, error, onRetry, retryLabel }: SectionErrorProps) {
  return (
    <div className="pg-inline-error sec-status" role="alert">
      <div>
        <p>{text}</p>
        {error ? <ErrorDetails error={error} /> : null}
      </div>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        <RefreshIcon aria-hidden="true" />
        {retryLabel ?? t('security.audit.retry')}
      </button>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  text: string;
  children?: ReactNode;
}

export function SectionEmpty({ title, text, children }: EmptyStateProps) {
  return (
    <div className="sec-empty" role="status">
      <strong>{title}</strong>
      <p>{text}</p>
      {children}
    </div>
  );
}

interface PaginationProps {
  hasMore: boolean;
  loadingMore: boolean;
  moreError: ApiError | null;
  onLoadMore: () => void;
  loadMoreLabel?: string;
  loadingLabel?: string;
  errorLabel?: string;
}

export function SectionPagination({
  hasMore,
  loadingMore,
  moreError,
  onLoadMore,
  loadMoreLabel,
  loadingLabel,
  errorLabel,
}: PaginationProps) {
  if (moreError) {
    return (
      <div className="sec-more" role="alert">
        <p>{errorLabel ?? t('security.audit.loadMoreError')}</p>
        <ErrorDetails error={moreError} />
        <button type="button" className="btn btn--sm" onClick={onLoadMore}>
          {t('security.audit.retry')}
        </button>
      </div>
    );
  }
  if (!hasMore) return null;
  return (
    <div className="sec-more">
      <button type="button" className="btn btn--sm" onClick={onLoadMore} disabled={loadingMore}>
        {loadingMore
          ? (loadingLabel ?? t('security.audit.loadingMore'))
          : (loadMoreLabel ?? t('security.audit.loadMore'))}
      </button>
    </div>
  );
}
