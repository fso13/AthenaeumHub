import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

async function openMentionsTab(user: ReturnType<typeof renderApp>['user']) {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(await screen.findByRole('button', { name: 'Уведомления: 2 непрочитанных' }));
  await user.click(await screen.findByRole('tab', { name: /Упоминания/ }));
  return screen.findByRole('list', { name: 'Упоминания' });
}

describe('#83 mention inbox', () => {
  it('lists server mentions, marks one read and then all read', async () => {
    const { user } = renderApp();
    const list = await openMentionsTab(user);
    expect(mockDb.mentionListRequests.at(-1)).toMatchObject({ unread: null });

    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Команда «Восход»');
    expect(rows[0]).toHaveTextContent('Непрочитано');
    expect(rows[1]).toHaveTextContent('Упоминание всех');

    await user.click(within(rows[0]!).getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(() =>
      expect(mockDb.mentionReadRequests.at(-1)?.body).toEqual({
        ids: ['e0000000-0000-4000-8000-000000000001'],
      }),
    );
    expect(within(rows[0]!).getByText('Прочитано')).toBeInTheDocument();
  });

  it('marks every mention read with one idempotent request', async () => {
    const { user } = renderApp();
    await openMentionsTab(user);
    await user.click(screen.getByRole('button', { name: 'Прочитать все' }));
    await waitFor(() => expect(mockDb.mentionReadRequests.at(-1)?.body).toEqual({ all: true }));
    await waitFor(() =>
      expect(mockDb.mentions.every((mention) => mention.read_at !== null)).toBe(true),
    );
  });

  it('applies the server unread filter and opens the mention chat', async () => {
    for (const mention of mockDb.mentions) mention.read_at = null;
    const { store, user } = renderApp();
    await openMentionsTab(user);

    await user.click(screen.getByRole('checkbox', { name: 'Только непрочитанные' }));
    await waitFor(() => expect(mockDb.mentionListRequests.at(-1)?.unread).toBe('true'));
    const list = await screen.findByRole('list', { name: 'Упоминания' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    const directRow = within(list)
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Упоминание всех'));
    expect(directRow).toBeDefined();
    await user.click(within(directRow!).getByRole('button', { name: /Упоминание всех/ }));
    await waitFor(() => expect(store.getSnapshot().activeChatId).toBe(IDS.directChat));
    await waitFor(() =>
      expect(
        mockDb.mentions.find((mention) => mention.chat_id === IDS.directChat)?.read_at,
      ).not.toBeNull(),
    );
  });

  it('shows an honest error and retries', async () => {
    mockDb.forceMentionListError = {
      status: 503,
      code: 'MENTIONS_UNAVAILABLE',
      message: 'Unavailable',
    };
    const { user } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await user.click(await screen.findByRole('button', { name: 'Уведомления: 2 непрочитанных' }));
    await user.click(await screen.findByRole('tab', { name: /Упоминания/ }));

    expect(await screen.findByText('Не удалось загрузить упоминания')).toBeInTheDocument();
    mockDb.forceMentionListError = null;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('list', { name: 'Упоминания' })).toBeInTheDocument();
  });

  it('passes an axe audit with the mention tab open', async () => {
    const { user } = renderApp();
    await openMentionsTab(user);
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
