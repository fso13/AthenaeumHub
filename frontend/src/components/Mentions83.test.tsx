import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const CHAT = IDS.groupChat;

async function openComposer(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  return screen.findByLabelText('Текст сообщения');
}

function setOwnerChatRole(role: 'OWNER' | 'MEMBER'): void {
  const member = mockDb.chatMembers[CHAT]?.find((row) => row.user_id === IDS.user);
  if (member) member.role = role;
}

describe('#83 server mentions payload', () => {
  it('sends explicit mention ids derived from the final text', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, 'Привет @Ан');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('Привет @Анна Петрова '));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mockDb.sendBodies).toHaveLength(1));
    expect(mockDb.sendBodies[0]).toMatchObject({
      text: 'Привет @Анна Петрова',
      mentions: [IDS.anna],
    });
    // `mention_all: false` is the contract default; the client omits it.
    expect(mockDb.sendBodies[0]?.mention_all ?? false).toBe(false);

    const chip = await waitFor(() => {
      const element = document.querySelector('.msg-row .mention');
      if (!element) throw new Error('mention chip is not rendered');
      return element;
    });
    expect(chip).toHaveTextContent('@Анна Петрова');
  });

  it('does not offer @all to a non-manager chat role', async () => {
    setOwnerChatRole('MEMBER');
    const { store, user } = renderApp();
    const textarea = await openComposer();
    await waitFor(() => expect(store.chatActorRole(CHAT)).toBe('MEMBER'));

    await user.click(textarea);
    await user.type(textarea, '@al');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    expect(screen.queryByRole('option', { name: 'Упоминание всех участников' })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Упоминания' })).toHaveTextContent(
      'Никого не нашли',
    );
  });

  it('sends @all for a manager and surfaces an honest 403 when the server denies it', async () => {
    const { store, user } = renderApp();
    const textarea = await openComposer();
    await waitFor(() => expect(store.chatActorRole(CHAT)).toBe('OWNER'));

    await user.click(textarea);
    await user.type(textarea, '@al');
    const all = await screen.findByRole('option', { name: 'Упоминание всех участников' });
    expect(all).toHaveTextContent('Все');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textarea).toHaveValue('@all '));

    // The UI advertised @all while the role allowed it; the server is the
    // authority and now denies the broadcast.
    setOwnerChatRole('MEMBER');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(
        'Упоминание всех участников доступно только владельцу и администратору чата.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockDb.sendBodies.at(-1)).toMatchObject({ mention_all: true }));
    setOwnerChatRole('OWNER');
  });

  it('keeps the mention picker accessible (axe)', async () => {
    const { user } = renderApp();
    const textarea = await openComposer();
    await user.click(textarea);
    await user.type(textarea, '@Ан');
    await screen.findByRole('listbox', { name: 'Упоминания' });
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });
});
