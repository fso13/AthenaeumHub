import type { ReactNode } from 'react';
import { t } from '../../i18n/ru';
import { ArrowLeftIcon } from '../Icons';

interface PageHeaderProps {
  /** Workspace · security mode, e.g. «Студия «Восход» · Управляемый». */
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** The h1 id used by the surrounding `<main aria-labelledby>`. */
  titleId?: string;
  actions?: ReactNode;
  onBack: () => void;
}

/**
 * D1 UX fidelity 2: the 64 px section header from `design/dashboard` — back
 * control, uppercase eyebrow, 18 px title and right-aligned actions.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  titleId,
  actions,
  onBack,
}: PageHeaderProps) {
  return (
    <header className="page-head">
      <button
        type="button"
        className="page-back"
        onClick={onBack}
        aria-label={t('page.backToChat')}
        title={t('page.backToChat')}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </button>
      <div className="page-heading">
        <span className="page-eyebrow">{eyebrow}</span>
        <h1 className="page-title" id={titleId}>
          {title}
        </h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
