import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatSummary } from '../api/types';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('#99 exact chat member_count in the header', () => {
  it('uses the chat contract count instead of the workspace directory size', async () => {
    const summary = mockDb.chats[IDS.groupChat]!.summary as ChatSummary & {
      member_count?: number;
    };
    summary.member_count = 7;
    const result = renderApp();
    stores.push(result.store);

    await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
    // The workspace directory fallback is smaller; the header must show 7.
    await waitFor(() =>
      expect(result.store.getSnapshot().workspaceMembers.items.length).toBeLessThan(7),
    );
    expect(await screen.findByText(/7 участников/)).toBeInTheDocument();
  });
});
