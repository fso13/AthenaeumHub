import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { IDS } from '../mocks/fixtures';
import { readPinnedChatIds } from '../sidebar/pins';
import type { ChatStore } from '../store/chatStore';
import { renderApp } from '../test/renderApp';

const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function waitForSidebar(): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await screen.findByRole('complementary', { name: 'Пространство и чаты' });
}

function chatRow(name: RegExp): HTMLElement {
  const button = screen.getByRole('button', { name });
  const row = button.closest('li');
  if (!(row instanceof HTMLElement)) throw new Error('chat row is not rendered');
  return row;
}

describe('personal sidebar pins', () => {
  it('pins a chat into the top section, filters it from «Каналы» and persists per user', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForSidebar();

    const row = chatRow(/Команда «Восход», Групповой чат/);
    const pin = within(row).getByRole('button', { name: 'Закрепить чат' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: 'Закреплённые' })).not.toBeInTheDocument();

    await result.user.hover(row);
    await result.user.click(pin);

    const pinnedSection = await screen.findByRole('region', { name: 'Закреплённые' });
    expect(
      within(pinnedSection).getByRole('button', { name: /Команда «Восход», Групповой чат/ }),
    ).toBeInTheDocument();
    expect(within(pinnedSection).getByRole('button', { name: 'Открепить чат' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The only group chat now lives in the pinned section; «Каналы» is empty
    // and therefore not rendered at all.
    expect(screen.queryByRole('region', { name: 'Каналы' })).not.toBeInTheDocument();
    expect(readPinnedChatIds(IDS.user)).toEqual([IDS.groupChat]);

    // A fresh mount with the same user reads the persisted list.
    result.unmount();
    const remounted = renderApp();
    stores.push(remounted.store);
    await waitForSidebar();
    expect(await screen.findByRole('region', { name: 'Закреплённые' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Закреплённые' })).getByRole('button', {
        name: /Команда «Восход», Групповой чат/,
      }),
    ).toBeInTheDocument();
  });

  it('toggles from the keyboard and unpins back into the channel list', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForSidebar();

    const row = chatRow(/Команда «Восход», Групповой чат/);
    const pin = within(row).getByRole('button', { name: 'Закрепить чат' });
    pin.focus();
    expect(pin).toHaveFocus();
    await result.user.keyboard('{Enter}');

    // The row moved into the pinned section, so the freshly rendered control
    // keeps keyboard focus.
    const unpin = await screen.findByRole('button', { name: 'Открепить чат' });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(unpin).toHaveFocus());
    await result.user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Закреплённые' })).not.toBeInTheDocument(),
    );
    const channels = await screen.findByRole('region', { name: 'Каналы' });
    const pinAgain = within(channels).getByRole('button', { name: 'Закрепить чат' });
    expect(pinAgain).toHaveAttribute('aria-pressed', 'false');
    expect(
      await screen.findByRole('button', { name: /Команда «Восход», Групповой чат/ }),
    ).toBeInTheDocument();
    expect(readPinnedChatIds(IDS.user)).toEqual([]);
    await waitFor(() => expect(pinAgain).toHaveFocus());
  });

  it('passes an axe audit with a pinned chat', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForSidebar();
    const row = chatRow(/Команда «Восход», Групповой чат/);
    await result.user.click(within(row).getByRole('button', { name: 'Закрепить чат' }));
    await screen.findByRole('region', { name: 'Закреплённые' });

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
