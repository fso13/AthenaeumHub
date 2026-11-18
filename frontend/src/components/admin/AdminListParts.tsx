import type { ReactNode } from 'react';

interface AdminCellProps {
  label: string;
  children: ReactNode;
  /** Emphasised identity cell (spans the card width on mobile). */
  primary?: boolean;
  className?: string;
}

/**
 * One labelled fact of an admin row. Desktop renders aligned columns with a
 * visual header; below the card breakpoint the label becomes visible and rows
 * become stacked cards. The `<dt>` stays in the accessibility tree in both
 * modes, so the value always has a programmatic label.
 */
export function AdminCell({ label, children, primary = false, className }: AdminCellProps) {
  return (
    <div
      className={['admin-cell', primary ? 'admin-cell--primary' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <dt className="admin-cell__label">{label}</dt>
      <dd className="admin-cell__value">{children}</dd>
    </div>
  );
}

/** Visual column header; hidden on mobile, where each cell carries its label. */
export function AdminRowsHead({ labels }: { labels: string[] }) {
  return (
    <div className="admin-rows__head" aria-hidden="true">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

export function AdminRow({ children }: { children: ReactNode }) {
  return (
    <li className="admin-row">
      <dl className="admin-row__grid">{children}</dl>
    </li>
  );
}
