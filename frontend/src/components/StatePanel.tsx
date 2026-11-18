import type { ReactNode } from 'react';
import type { ApiError } from '../api/problem';
import { ErrorDetails } from './ErrorDetails';

type Tone = 'neutral' | 'error' | 'forbidden' | 'success';

interface StatePanelProps {
  title: string;
  text: string;
  tone?: Tone;
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  details?: ApiError | null;
}

export function StatePanel({
  title,
  text,
  tone = 'neutral',
  icon,
  actionLabel,
  onAction,
  details,
}: StatePanelProps) {
  const isAlert = tone === 'error' || tone === 'forbidden';

  return (
    <section
      className={`state-panel state-panel--${tone}`}
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
    >
      {icon ? <div className="state-panel__icon">{icon}</div> : null}
      <h2 className="state-panel__title">{title}</h2>
      <p className="state-panel__text">{text}</p>
      {actionLabel && onAction ? (
        <button type="button" className="button button--primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {details ? <ErrorDetails error={details} /> : null}
    </section>
  );
}
