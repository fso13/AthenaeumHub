import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { insertMockMessage, insertMockThreadReply } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const CHAT = IDS.groupChat;

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`message-${id}`);
  if (row === null) throw new Error(`Message row ${id} is not rendered`);
  return row;
}

describe('rich text in the managed feed', () => {
  it('renders markdown, a code block and mention chips in a message row', async () => {
    const message = insertMockMessage(
      mockDb,
      CHAT,
      '**привет** @Анна Петрова\n\n- один\n- два\n\n```ts\nconst answer = 42;\n```',
    );
    const { store } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await store.loadWorkspaceMembers({ query: '' });

    const row = await waitFor(() => rowFor(message.id));
    expect(within(row).getByText('привет').tagName).toBe('STRONG');
    expect(within(row).getByText('@Анна Петрова')).toHaveClass('mention');
    expect(row.querySelectorAll('.rich-list li')).toHaveLength(2);
    expect(within(row).getByText('TypeScript')).toBeInTheDocument();
    expect(row.querySelector('.code-block__code')?.textContent).toBe('const answer = 42;');
  });

  it('keeps raw HTML as text in a managed message row', async () => {
    const message = insertMockMessage(
      mockDb,
      CHAT,
      '<script>alert(1)</script> <b>не жирный</b> <img src=x onerror=alert(1)>',
    );
    const { container } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const row = await waitFor(() => rowFor(message.id));
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('.msg-text b')).toBeNull();
  });

  it('renders markdown and mention chips in the thread panel root preview and replies', async () => {
    const root = insertMockMessage(mockDb, CHAT, 'Привет @Анна Петрова');
    insertMockThreadReply(mockDb, CHAT, root.id, '**ответ** с `кодом`\n\n```ts\nconst x = 1;\n```');

    const { user, store } = renderApp();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await store.loadWorkspaceMembers({ query: '' });

    const row = await waitFor(() => rowFor(root.id));
    await user.click(within(row).getByRole('button', { name: /Начать тред|Открыть тред/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Тред' });
    await within(dialog).findByText('ответ');

    expect(dialog.querySelector('.thread-panel__root-text .mention')).toHaveTextContent(
      '@Анна Петрова',
    );
    expect(within(dialog).getByText('ответ').tagName).toBe('STRONG');
    expect(within(dialog).getByText('TypeScript')).toBeInTheDocument();
    expect(dialog.querySelector('.thread-panel__body .code-block__code')?.textContent).toBe(
      'const x = 1;',
    );
  });
});
