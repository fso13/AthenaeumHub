import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { insertMockMessage } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const GROUP = IDS.groupChat;
const MARKER = 'КВАРЦ-МАРКЕР';

async function openSearch(user: ReturnType<typeof renderApp>['user']) {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(screen.getByRole('button', { name: 'Поиск по переписке' }));
  return screen.findByPlaceholderText('Поиск по переписке');
}

describe('#83 server message search', () => {
  it('shows a hint before a query and searches the server with highlights', async () => {
    const original = insertMockMessage(mockDb, GROUP, `Отчёт ${MARKER} готов к проверке`);
    const { user } = renderApp();
    const input = await openSearch(user);

    expect(screen.getByText('Поиск по всем чатам')).toBeInTheDocument();
    expect(mockDb.searchRequests).toHaveLength(0);

    await user.type(input, MARKER);
    const list = await screen.findByRole('list', { name: 'Результаты поиска' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    const hit = within(list).getByRole('button');
    expect(hit).toHaveTextContent('Команда «Восход»');
    expect(within(hit).getByText(MARKER).tagName).toBe('MARK');
    expect(mockDb.searchRequests.at(-1)).toMatchObject({ q: MARKER, limit: '20' });

    await user.click(hit);
    expect(screen.queryByRole('list', { name: 'Результаты поиска' })).toBeNull();
    await waitFor(() => {
      const row = document.getElementById(`message-${original.id}`);
      expect(row).not.toBeNull();
      expect(row).toHaveClass('is-focused');
    });
  });

  it('pages with the opaque cursor and keeps the chat name on every hit', async () => {
    for (let index = 0; index < 25; index += 1) {
      insertMockMessage(mockDb, GROUP, `Сообщение ${index} ${MARKER}`);
    }
    const { user } = renderApp();
    const input = await openSearch(user);
    await user.type(input, MARKER);

    const list = await screen.findByRole('list', { name: 'Результаты поиска' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(20));
    const firstCursor = mockDb.searchRequests.at(-1)?.cursor;
    expect(firstCursor).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(25));
    expect(mockDb.searchRequests.at(-1)?.cursor).toBeTruthy();
    expect(mockDb.searchRequests.at(-1)?.q).toBe(MARKER);
  });

  it('renders the empty and error states without inventing results', async () => {
    mockDb.forceSearchError = {
      status: 503,
      code: 'SEARCH_UNAVAILABLE',
      message: 'Search is unavailable',
    };
    const { user } = renderApp();
    const input = await openSearch(user);
    await user.type(input, 'ничего-нет');

    expect(await screen.findByText('Поиск недоступен')).toBeInTheDocument();
    mockDb.forceSearchError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('passes an axe audit with results rendered', async () => {
    insertMockMessage(mockDb, GROUP, `Безопасность ${MARKER}`);
    const { user } = renderApp();
    const input = await openSearch(user);
    await user.type(input, MARKER);
    await screen.findByRole('list', { name: 'Результаты поиска' });

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
