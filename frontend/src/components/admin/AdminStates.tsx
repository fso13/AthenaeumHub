import type { ReactNode } from 'react';
import type { ApiError } from '../../api/problem';
import { t } from '../../i18n/ru';
import { ErrorDetails } from '../ErrorDetails';

interface AdminSkeletonProps {
  /** Announced to screen readers; the skeleton itself is aria-hidden decoration. */
  label: string;
  rows?: number;
}

/** Fixed-height skeleton: no layout shift when the page arrives. */
export function AdminSkeleton({ label, rows = 5 }: AdminSkeletonProps) {
  return (
    <div className="admin-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="admin-skeleton__row" key={index} aria-hidden="true">
          <span className="skeleton admin-skeleton__cell admin-skeleton__cell--wide" />
          <span className="skeleton admin-skeleton__cell" />
          <span className="skeleton admin-skeleton__cell admin-skeleton__cell--short" />
          <span className="skeleton admin-skeleton__cell admin-skeleton__cell--short" />
        </div>
      ))}
    </div>
  );
}

interface AdminErrorStateProps {
  text: string;
  error?: ApiError | null;
  onRetry: () => void;
  retryLabel?: string;
}

export function AdminErrorState({ text, error, onRetry, retryLabel }: AdminErrorStateProps) {
  return (
    <div className="admin-state admin-state--error" role="alert">
      <div className="admin-state__body">
        <p>{text}</p>
        {error ? <ErrorDetails error={error} /> : null}
      </div>
      <button type="button" className="button button--secondary" onClick={onRetry}>
        {retryLabel ?? t('admin.users.retry')}
      </button>
    </div>
  );
}

interface AdminEmptyStateProps {
  title: string;
  text: string;
  children?: ReactNode;
}

export function AdminEmptyState({ title, text, children }: AdminEmptyStateProps) {
  return (
    <div className="admin-empty" role="status">
      <h3 className="admin-empty__title">{title}</h3>
      <p className="admin-empty__text">{text}</p>
      {children}
    </div>
  );
}

interface AdminListCountProps {
  label: string;
}

export function AdminListCount({ label }: AdminListCountProps) {
  return (
    <p className="admin-list-count" role="status">
      {label}
    </p>
  );
}
