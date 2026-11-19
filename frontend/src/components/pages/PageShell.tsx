import { useEffect, useId, useRef, type ReactNode } from 'react';
import { PageHeader } from './PageHeader';

interface PageShellProps {
  title: string;
  /** Workspace · mode line; pages pass it from the active workspace. */
  eyebrow?: string;
  subtitle?: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * D1 UX fidelity 2: common workspace section layout. The heading is the page's
 * single `h1`; the back control returns to the preserved chat surface.
 */
export function PageShell({ title, eyebrow, subtitle, onBack, actions, children }: PageShellProps) {
  const titleId = useId();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the new section so keyboard/screen-reader users land on it.
  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  return (
    <main className="page" id="chat-main" tabIndex={-1} aria-labelledby={titleId} ref={mainRef}>
      <PageHeader
        eyebrow={eyebrow ?? ''}
        title={title}
        subtitle={subtitle}
        titleId={titleId}
        onBack={onBack}
        actions={actions}
      />
      <div className="page-body">{children}</div>
    </main>
  );
}
