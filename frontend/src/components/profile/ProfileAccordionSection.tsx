import type { ReactNode } from 'react';
import { ChevronRightIcon } from '../Icons';

export interface ProfileAccordionSectionProps {
  /** Stable id used for the trigger/panel pair (a11y + tests). */
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Optional status chip rendered after the title. */
  badge?: ReactNode;
  children: ReactNode;
}

/**
 * #107 collapsible profile block.
 *
 * A real button owns `aria-expanded`/`aria-controls`; the panel is the only
 * labelled region and is removed from the accessibility tree with `hidden`
 * while collapsed. Keeping the panel mounted preserves in-flight state (2FA setup,
 * session list) without leaving focusable controls reachable.
 */
export function ProfileAccordionSection({
  id,
  title,
  open,
  onToggle,
  badge,
  children,
}: ProfileAccordionSectionProps) {
  const triggerId = `profile-section-${id}-trigger`;
  const panelId = `profile-section-${id}-panel`;
  return (
    <div className={`profile-accordion${open ? ' is-open' : ''}`}>
      <h4 className="profile-accordion__heading">
        <button
          type="button"
          id={triggerId}
          className="profile-accordion__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <ChevronRightIcon className="profile-accordion__chevron" aria-hidden="true" />
          <span className="profile-accordion__title">{title}</span>
          {badge ? <span className="profile-accordion__badge">{badge}</span> : null}
        </button>
      </h4>
      <div
        id={panelId}
        className="profile-accordion__panel"
        role="region"
        aria-labelledby={triggerId}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
