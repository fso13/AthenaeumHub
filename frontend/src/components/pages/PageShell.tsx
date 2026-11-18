import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../../i18n/ru';
import { ArrowLeftIcon } from '../Icons';

interface PageShellProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * D1-FE1: common workspace section layout. The heading is the page's single
 * `h1`; the back control returns to the preserved chat surface.
 */
export function PageShell({ title, subtitle, onBack, actions, children }: PageShellProps) {
  const titleId = useId();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the new section so keyboard/screen-reader users land on it.
  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  return (
    <main className="page" id="chat-main" tabIndex={-1} aria-labelledby={titleId} ref={mainRef}>
      <header className="page__head">
        <button
          type="button"
          className="icon-button page__back"
          onClick={onBack}
          aria-label={t('page.backToChat')}
          title={t('page.backToChat')}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </button>
        <div className="page__heading">
          <h1 className="page__title" id={titleId}>
            {title}
          </h1>
          {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page__actions">{actions}</div> : null}
      </header>
      <div className="page__body">{children}</div>
    </main>
  );
}
