import type { BotCommand, ChatBot } from '../api/types';

/**
 * #98 slash-command helpers shared by the composer and its palette.
 *
 * The composer only treats a leading `/` as a command when the name is
 * registered by a bot that is installed, enabled and ACTIVE in the current
 * chat. Anything else stays an ordinary message: the server owns the final
 * `BOT_COMMAND_NOT_FOUND` / `BOT_COMMAND_AMBIGUOUS` verdicts.
 */

export interface BotCommandOption extends BotCommand {
  readonly botId: string;
  readonly botName: string;
}

export interface ParsedSlashCommand {
  /** Lowercase command name without the leading slash. */
  readonly command: string;
  /** Free text after the command, trimmed (contract: args are `strip()`ed). */
  readonly args: string;
}

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SLASH_INPUT = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})(?:[ \t]+([\s\S]*))?$/;

/** Registered command names are lowercase per the contract. */
export function isValidCommandName(value: string): boolean {
  return COMMAND_PATTERN.test(value);
}

/**
 * Parses `/name args`. Returns `null` for ordinary text (no leading slash, a
 * bare `/`, or characters outside the command alphabet), so the composer can
 * fall back to `POST .../messages` instead of inventing an invocation.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = SLASH_INPUT.exec(text);
  if (!match) return null;
  return {
    command: (match[1] ?? '').toLowerCase(),
    args: (match[2] ?? '').trim(),
  };
}

/**
 * The unfinished command token while the caret is still in the name (no
 * whitespace yet). `null` closes the palette once arguments are typed.
 */
export function slashCommandQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  if (rest.length === 0) return '';
  if (/[\s]/.test(rest)) return null;
  return rest.toLowerCase();
}

/** Prefix matches first, then substring matches; duplicates stay per bot. */
export function matchBotCommands(
  options: readonly BotCommandOption[],
  query: string,
): BotCommandOption[] {
  const normalized = query.toLowerCase();
  const prefix: BotCommandOption[] = [];
  const contains: BotCommandOption[] = [];
  for (const option of options) {
    if (option.command.startsWith(normalized)) prefix.push(option);
    else if (option.command.includes(normalized)) contains.push(option);
  }
  return [...prefix, ...contains];
}

/**
 * Flattens `GET /chats/{id}/bots` into palette rows. Only effective bots
 * (installation enabled + bot ACTIVE) expose commands, mirroring the server's
 * `findTargets` filter.
 */
export function buildBotCommandOptions(items: readonly ChatBot[]): BotCommandOption[] {
  const options: BotCommandOption[] = [];
  for (const item of items) {
    if (!item.enabled || item.bot.status !== 'ACTIVE') continue;
    for (const command of item.bot.commands ?? []) {
      options.push({
        command: command.command,
        description: command.description,
        botId: item.bot.id,
        botName: item.bot.name,
      });
    }
  }
  return options;
}

/** Exact command owner used by submit; `null` means "send as a message". */
export function findBotCommand(
  options: readonly BotCommandOption[],
  command: string,
): BotCommandOption | null {
  const normalized = command.toLowerCase();
  return options.find((option) => option.command === normalized) ?? null;
}
