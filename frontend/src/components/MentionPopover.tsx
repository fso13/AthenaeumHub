import type { MentionCandidate } from '../domain/mentions';
import { t } from '../i18n/ru';

interface MentionPopoverProps {
  readonly listboxId: string;
  readonly candidates: readonly MentionCandidate[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly onSelect: (candidate: MentionCandidate) => void;
  readonly onActive: (index: number) => void;
}

/**
 * Accessible listbox for composer mention autocomplete.
 *
 * Focus never leaves the textarea: options are selected with the arrow keys and
 * Enter, and pointer selection uses `mousedown` + `preventDefault` so the
 * textarea keeps its selection/caret.
 */
export function MentionPopover({
  listboxId,
  candidates,
  activeIndex,
  loading,
  onSelect,
  onActive,
}: MentionPopoverProps) {
  return (
    <div className="mention-pop" id={listboxId} role="listbox" aria-label={t('mentions.listLabel')}>
      {candidates.map((candidate, index) => {
        const selected = index === activeIndex;
        return (
          <div
            key={candidate.key}
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={selected}
            aria-label={
              candidate.all
                ? t('mentions.allAria')
                : t('mentions.userAria', { name: candidate.name })
            }
            className={`mention-pop__option${selected ? ' is-active' : ''}${
              candidate.all ? ' mention-pop__option--all' : ''
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(candidate);
            }}
            onMouseEnter={() => onActive(index)}
          >
            <span className="mention-pop__at" aria-hidden="true">
              @
            </span>
            <span className="mention-pop__name">
              {candidate.all ? t('mentions.all') : candidate.name}
            </span>
            {candidate.all ? (
              <span className="mention-pop__hint">{t('mentions.allHint')}</span>
            ) : null}
          </div>
        );
      })}
      {candidates.length === 0 ? (
        <p className="mention-pop__state" role="status">
          {loading ? t('mentions.loading') : t('mentions.empty')}
        </p>
      ) : null}
    </div>
  );
}
