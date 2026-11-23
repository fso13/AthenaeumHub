import type { BotCommandOption } from '../../bots/commands';
import { t } from '../../i18n/ru';

interface CommandPaletteProps {
  readonly listboxId: string;
  readonly options: readonly BotCommandOption[];
  readonly activeIndex: number;
  readonly onSelect: (option: BotCommandOption) => void;
  readonly onActive: (index: number) => void;
}

/**
 * #98 slash-command palette.
 *
 * Same combobox/listbox pattern as the mention popover: focus stays in the
 * textarea, arrows move the active option, Enter/Tab inserts and Escape closes.
 * Only commands of installed/enabled/ACTIVE bots are listed; the server still
 * rejects unknown or ambiguous names with `404`/`409`.
 */
export function CommandPalette({
  listboxId,
  options,
  activeIndex,
  onSelect,
  onActive,
}: CommandPaletteProps) {
  return (
    <div
      className="mention-pop command-pop"
      id={listboxId}
      role="listbox"
      aria-label={t('composer.command.listLabel')}
    >
      {options.map((option, index) => {
        const selected = index === activeIndex;
        return (
          <div
            key={`${option.botId}:${option.command}`}
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={selected}
            aria-label={t('composer.command.optionAria', {
              command: option.command,
              description: option.description,
              bot: option.botName,
            })}
            className={`mention-pop__option command-pop__option${selected ? ' is-active' : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(option);
            }}
            onMouseEnter={() => onActive(index)}
          >
            <span className="command-pop__name">/{option.command}</span>
            <span className="command-pop__description">{option.description}</span>
            <span className="command-pop__bot">{option.botName}</span>
          </div>
        );
      })}
      {options.length === 0 ? (
        <p className="mention-pop__state" role="status">
          {t('composer.command.empty')}
        </p>
      ) : null}
      <p className="command-pop__hint">{t('composer.command.hint')}</p>
    </div>
  );
}
