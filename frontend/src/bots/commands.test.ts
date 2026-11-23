import { describe, expect, it } from 'vitest';
import type { ChatBot } from '../api/types';
import {
  buildBotCommandOptions,
  findBotCommand,
  isValidCommandName,
  matchBotCommands,
  parseSlashCommand,
  slashCommandQuery,
} from './commands';

function chatBot(overrides: Partial<ChatBot> = {}): ChatBot {
  return {
    chat_id: '44444444-4444-4444-8444-444444444444',
    bot: {
      id: 'b0000000-0000-4000-8000-000000000001',
      workspace_id: '33333333-3333-4333-8333-333333333333',
      name: 'Сова Помощник',
      avatar_file_id: null,
      scopes: ['chat.write'],
      status: 'ACTIVE',
      created_by: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-01-10T09:00:00.000Z',
      updated_at: '2026-01-10T09:00:00.000Z',
      commands: [
        { command: 'echo', description: 'Повторить текст' },
        { command: 'status', description: 'Показать статус' },
      ],
    },
    enabled: true,
    installed_at: '2026-01-11T09:00:00.000Z',
    ...overrides,
  };
}

describe('#98 slash-command helpers', () => {
  it('parses only a real leading command and trims arguments', () => {
    expect(parseSlashCommand('/echo hello world')).toEqual({
      command: 'echo',
      args: 'hello world',
    });
    expect(parseSlashCommand('/echo')).toEqual({ command: 'echo', args: '' });
    expect(parseSlashCommand('/ECHO  hi  ')).toEqual({ command: 'echo', args: 'hi' });
    expect(parseSlashCommand('hello /echo')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/echo!')).toBeNull();
    expect(parseSlashCommand(' /echo')).toBeNull();
  });

  it('opens the palette only while the command name is unfinished', () => {
    expect(slashCommandQuery('/ec')).toBe('ec');
    expect(slashCommandQuery('/')).toBe('');
    expect(slashCommandQuery('/echo hi')).toBeNull();
    expect(slashCommandQuery('hello')).toBeNull();
  });

  it('matches commands by prefix first and substring second', () => {
    const options = buildBotCommandOptions([chatBot()]);
    expect(matchBotCommands(options, 'st').map((option) => option.command)).toEqual(['status']);
    expect(matchBotCommands(options, 'ho').map((option) => option.command)).toEqual(['echo']);
    expect(findBotCommand(options, 'ECHO')?.botName).toBe('Сова Помощник');
    expect(findBotCommand(options, 'missing')).toBeNull();
  });

  it('exposes commands only for effectively enabled ACTIVE bots', () => {
    const options = buildBotCommandOptions([
      chatBot(),
      chatBot({ enabled: false }),
      chatBot({
        bot: { ...chatBot().bot, status: 'DISABLED' },
      }),
    ]);
    expect(options.map((option) => option.command)).toEqual(['echo', 'status']);
  });

  it('validates lowercase command names against the contract pattern', () => {
    expect(isValidCommandName('echo')).toBe(true);
    expect(isValidCommandName('deploy-2')).toBe(true);
    expect(isValidCommandName('Deploy')).toBe(false);
    expect(isValidCommandName('/echo')).toBe(false);
    expect(isValidCommandName('')).toBe(false);
  });
});
