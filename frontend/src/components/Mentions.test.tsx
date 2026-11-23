import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { getDeviceId } from '../auth/session';
import { insertMockMessage } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import { createFakeE2eeBridge, makeEnvelope } from '../test/e2eeBridgeFake';

const CHAT = IDS.groupChat;
const PEER_DEVICE = '55555555-5555-4555-8555-555555555555';
const PEER_USER = '22222222-2222-4222-8222-222222222222';

async function openComposer(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  return screen.findByLabelText('Текст сообщения');
}

function feedChip(): HTMLElement | null {
  return document.querySelector('.msg-row .mention');
}

describe('@mentions in the managed composer', () => {
  it('loads the directory, filters by @query and inserts the display name on Enter', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, 'Привет @Ан');

    const listbox = await screen.findByRole('listbox', { name: 'Упоминания' });
    const option = await within(listbox).findByRole('option', {
      name: 'Упоминание: Анна Петрова',
    });
    expect(option).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('Привет @Анна Петрова '));
    expect(screen.queryByRole('listbox')).toBeNull();

    // A complete mention followed by message text must not reopen the picker.
    await user.type(textarea, 'и');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockDb.sendAttempts).toHaveLength(1));
    await waitFor(() => {
      const chip = feedChip();
      expect(chip).not.toBeNull();
      expect(chip).toHaveTextContent('@Анна Петрова');
    });
  });

  it('offers @all first and renders it with a distinct chip', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@al');

    const option = await screen.findByRole('option', {
      name: 'Упоминание всех участников',
    });
    expect(option).toHaveTextContent('Все');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('@all '));

    await user.keyboard('{Enter}');
    await waitFor(() => {
      const chip = document.querySelector('.msg-row .mention--all');
      expect(chip).not.toBeNull();
      expect(chip).toHaveAttribute('data-mention', 'all');
      expect(chip).toHaveTextContent('@all');
    });
  });

  it('supports ArrowDown then Enter', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@');

    const listbox = await screen.findByRole('listbox', { name: 'Упоминания' });
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(1);
    });

    await user.keyboard('{ArrowDown}');
    const anna = within(listbox).getByRole('option', { name: 'Упоминание: Анна Петрова' });
    expect(anna).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('@Анна Петрова '));
  });

  it('wraps with ArrowUp and inserts the last member', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@');

    const listbox = await screen.findByRole('listbox', { name: 'Упоминания' });
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.keyboard('{ArrowUp}');
    const last = within(listbox).getAllByRole('option').at(-1);
    expect(last).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('@Марк Соколов '));
  });

  it('closes on Escape without inserting or sending', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@Ан');
    await screen.findByRole('listbox', { name: 'Упоминания' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea).toHaveValue('@Ан');
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('does not trigger inside an email address', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, 'почта test@example.com');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea).toHaveValue('почта test@example.com');
  });

  it('exposes combobox/listbox ARIA state while the picker is open', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@Ан');

    const listbox = await screen.findByRole('listbox', { name: 'Упоминания' });
    const option = await within(listbox).findByRole('option', {
      name: 'Упоминание: Анна Петрова',
    });
    expect(textarea).toHaveAttribute('role', 'combobox');
    expect(textarea).toHaveAttribute('aria-autocomplete', 'list');
    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-controls', listbox.id);
    expect(textarea).toHaveAttribute('aria-activedescendant', option.id);
    expect(option).toHaveAttribute('aria-selected', 'true');
  });

  it('passes an axe audit with the mention picker open', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });

  it('renders mention chips in reply quotes after the directory is loaded', async () => {
    const original = insertMockMessage(mockDb, CHAT, 'Привет @Анна Петрова');
    const { store, user } = renderApp();
    await openComposer();
    await store.loadWorkspaceMembers({ query: '' });

    const row = await waitFor(() => {
      const element = document.getElementById(`message-${original.id}`);
      if (element === null) throw new Error('message row is not rendered yet');
      return element;
    });
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: /Ответить/ }));

    const replyBar = document.querySelector('.reply-bar__text');
    expect(replyBar?.querySelector('.mention')).not.toBeNull();
    expect(replyBar?.querySelector('.mention')).toHaveTextContent('@Анна Петрова');
  });

  it('offers mentions in the thread composer and renders the chip in a reply', async () => {
    const root = insertMockMessage(mockDb, CHAT, 'Корень треда');
    const { user } = renderApp();
    await openComposer();

    const rootRow = await waitFor(() => {
      const element = document.getElementById(`message-${root.id}`);
      if (element === null) throw new Error('thread root is not rendered yet');
      return element;
    });
    await user.hover(rootRow);
    await user.click(within(rootRow).getByRole('button', { name: 'Ещё действия' }));
    await user.click(within(rootRow).getByRole('button', { name: /Начать тред|Открыть тред/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Тред' });
    const input = within(dialog).getByLabelText('Ответ в тред');

    await user.click(input);
    await user.type(input, '@Ан');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    // Escape closes only the picker; the thread dialog and draft stay.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Тред' })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '@Ан');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveValue('@Анна Петрова '));

    await user.keyboard('{Enter}');
    const chip = await waitFor(() => {
      const element = dialog.querySelector('.thread-panel__body .mention');
      if (element === null) throw new Error('mention chip is not rendered yet');
      return element;
    });
    expect(chip).toHaveTextContent('@Анна Петрова');
  });
});

const SNAPSHOT = {
  chatId: CHAT,
  securityMode: 'E2EE' as const,
  modeAction: 'allow_e2ee' as const,
  peerDeviceIds: [PEER_DEVICE],
  devices: [
    {
      userId: PEER_USER,
      deviceId: PEER_DEVICE,
      fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      isSelf: false,
      verified: false,
      status: 'ACTIVE' as const,
    },
  ],
};

describe('E2EE messages stay plain text', () => {
  it('renders markdown and mention syntax literally and offers no autocomplete', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const selfDeviceId = getDeviceId() ?? '33333333-3333-4333-8333-333333333333';
    const incoming = insertMockMessage(mockDb, CHAT, 'SERVER_PLAINTEXT');
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, selfDeviceId);
    const bridge = createFakeE2eeBridge({
      deviceId: () => selfDeviceId,
      snapshot: { ...SNAPSHOT, selfDeviceId },
    });
    bridge.setIncomingText('**жирный** `код` @Анна Петрова [сайт](https://example.com)');

    const { user } = renderApp({}, { enabled: true, bridge });
    const textarea = await openComposer();
    const row = await waitFor(() => {
      const element = document.getElementById(`message-${incoming.id}`);
      if (element === null) throw new Error('E2EE message row is not rendered yet');
      return element;
    });

    expect(
      within(row).getByText('**жирный** `код` @Анна Петрова [сайт](https://example.com)'),
    ).toBeInTheDocument();
    expect(row.querySelector('strong')).toBeNull();
    expect(row.querySelector('code')).toBeNull();
    expect(row.querySelector('a')).toBeNull();
    expect(row.querySelector('.mention')).toBeNull();
    expect(row.querySelector('.code-block')).toBeNull();

    await user.click(textarea);
    await user.type(textarea, '@');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea).not.toHaveAttribute('role', 'combobox');
    // The typed '@' is plain draft text, not a mention chip.
    expect(textarea).toHaveValue('@');
  });
});
