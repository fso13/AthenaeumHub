import { act, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDS, messageId } from '../mocks/fixtures';
import {
  publishMockReactionChanged,
  publishMockMessageDeleted,
  publishMockMessageUpdated,
  mockRealtimeSubscribedChats,
} from '../mocks/realtime';
import { mockDb, server } from '../test/server';
import { renderApp } from '../test/renderApp';
import type { ChatStore } from '../store/chatStore';

const CHAT = IDS.groupChat;

function syncServerReaction(id: string, emoji: string, count: number, me: boolean): void {
  const message = mockDb.chats[CHAT]!.messages.find((item) => item.id === id);
  if (!message) throw new Error(`Unknown mock message ${id}`);
  const reactions = (message.reactions ?? []).filter((reaction) => reaction.emoji !== emoji);
  if (count > 0) reactions.push({ emoji, count, me });
  message.reactions = reactions;
}

function rowFor(id: string): HTMLElement {
  const row = document.getElementById(`message-${id}`);
  if (!row) {
    const rows = [...document.querySelectorAll('[id^="message-"]')].map((node) => node.id);
    throw new Error(
      `Message row ${id} is not rendered; rows=${rows.slice(0, 3).join(',')}; body=${(
        document.body.textContent ?? ''
      ).slice(0, 240)}`,
    );
  }
  return row;
}

async function waitForChat(store?: ChatStore): Promise<void> {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  if (store) {
    await waitFor(() => {
      expect(store.getSnapshot().slices[CHAT]?.status).toBe('ready');
    });
  }
}

async function waitForOnline(store: ChatStore): Promise<void> {
  await waitForChat(store);
  await vi.waitFor(
    () => {
      expect(store.getSnapshot().realtimeStatus).toBe('online');
      expect(mockRealtimeSubscribedChats()).toContain(CHAT);
    },
    { timeout: 4_000 },
  );
}

async function openEdit(
  user: ReturnType<typeof renderApp>['user'],
  id: string,
): Promise<HTMLElement> {
  const row = rowFor(id);
  await user.hover(row);
  await user.click(within(row).getByRole('button', { name: 'Редактировать сообщение' }));
  return screen.findByRole('dialog', { name: 'Редактировать сообщение' });
}

async function openDeleteMenu(
  user: ReturnType<typeof renderApp>['user'],
  id: string,
): Promise<HTMLElement> {
  const row = rowFor(id);
  await user.hover(row);
  await user.click(within(row).getByRole('button', { name: 'Удалить сообщение' }));
  return screen.findByRole('dialog', { name: 'Удалить сообщение' });
}

const stores: ChatStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('#61 reactions', () => {
  it('renders seeded aggregates and toggles the viewer reaction through the picker', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    // Seeded server aggregate: count + me from the contract shape.
    const reacted = rowFor(messageId(37));
    expect(within(reacted).getByRole('button', { name: /🎉: 4, ваша реакция/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(rowFor(messageId(31))).getByRole('button', { name: /❤️: 2$/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const row = rowFor(messageId(37));
    await result.user.click(within(row).getByRole('button', { name: 'Поставить реакцию' }));
    const picker = await screen.findByRole('dialog', { name: 'Выберите реакцию' });
    await result.user.click(within(picker).getByRole('button', { name: '👍' }));

    const chip = await within(row).findByRole('button', { name: /👍: 1, ваша реакция/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    const server = mockDb.chats[CHAT]!.messages.find((message) => message.id === messageId(37));
    expect(server?.reactions).toEqual(
      expect.arrayContaining([{ emoji: '👍', count: 1, me: true }]),
    );
    expect(mockDb.reactionRequests.at(-1)).toMatchObject({
      messageId: messageId(37),
      emoji: '👍',
      action: 'ADD',
    });

    // Clicking the chip again removes only the viewer reaction (idempotent).
    await result.user.click(chip);
    await waitFor(() => {
      expect(within(row).queryByRole('button', { name: /👍/ })).not.toBeInTheDocument();
    });
    expect(server?.reactions?.some((reaction) => reaction.emoji === '👍')).toBe(false);
    expect(mockDb.reactionRequests.at(-1)).toMatchObject({ action: 'REMOVE' });
  });

  it('applies live ADDED/REMOVED aggregates and keeps other users from changing me', async () => {
    const result = renderApp({ realtimeEnabled: true });
    stores.push(result.store);
    await waitForOnline(result.store);

    const id = messageId(37);
    const row = rowFor(id);
    await result.user.click(within(row).getByRole('button', { name: 'Поставить реакцию' }));
    const picker = await screen.findByRole('dialog', { name: 'Выберите реакцию' });
    await result.user.click(within(picker).getByRole('button', { name: '👍' }));
    await within(row).findByRole('button', { name: /👍: 1, ваша реакция/ });

    act(() => {
      syncServerReaction(id, '👍', 2, true);
      publishMockReactionChanged(mockDb, CHAT, id, IDS.mark, '👍', 'ADDED', 2);
    });
    expect(await within(row).findByRole('button', { name: /👍: 2, ваша реакция/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    act(() => {
      syncServerReaction(id, '🔥', 3, false);
      publishMockReactionChanged(mockDb, CHAT, id, IDS.lena, '🔥', 'ADDED', 3);
    });
    const fire = await within(row).findByRole('button', { name: /🔥: 3/ });
    expect(fire).toHaveAttribute('aria-pressed', 'false');

    // Toggle the viewer's own reaction on an existing aggregate: 3 → 4 → 3.
    await result.user.click(fire);
    await within(row).findByRole('button', { name: /🔥: 4, ваша реакция/ });
    await result.user.click(within(row).getByRole('button', { name: /🔥: 4, ваша реакция/ }));
    expect(await within(row).findByRole('button', { name: /🔥: 3/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    act(() => {
      syncServerReaction(id, '👍', 1, false);
      publishMockReactionChanged(mockDb, CHAT, id, IDS.user, '👍', 'REMOVED', 1);
    });
    expect(await within(row).findByRole('button', { name: /👍: 1$/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('rolls a failed reaction back and shows a translated error', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    mockDb.forceReactionError = {
      status: 403,
      code: 'FORBIDDEN',
      message: 'no access',
    };
    const row = rowFor(messageId(37));
    await result.user.click(within(row).getByRole('button', { name: 'Поставить реакцию' }));
    const picker = await screen.findByRole('dialog', { name: 'Выберите реакцию' });
    await result.user.click(within(picker).getByRole('button', { name: '👀' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent(/нет прав/i);
    expect(within(row).queryByRole('button', { name: /👀/ })).not.toBeInTheDocument();
  });
});

describe('#62 edit', () => {
  it('edits own managed text, shows the edited marker and keeps the version lock', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const id = messageId(37);
    const row = rowFor(id);

    const originalText =
      mockDb.chats[CHAT]!.messages.find((message) => message.id === id)?.text ?? '';
    const dialog = await openEdit(result.user, id);
    const textarea = within(dialog).getByLabelText('Редактировать сообщение');
    expect(textarea).toHaveValue(originalText);
    await result.user.clear(textarea);
    await result.user.type(textarea, 'Обновлённый текст сообщения');
    await result.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(await within(row).findByText('Обновлённый текст сообщения')).toBeInTheDocument();
    const marker = within(row).getByText('изменено');
    expect(marker).toHaveAttribute('title', expect.stringMatching(/Изменено \d{2}\.\d{2}\.\d{4}/));
    const saved = mockDb.chats[CHAT]!.messages.find((message) => message.id === id);
    expect(saved?.text).toBe('Обновлённый текст сообщения');
    expect(saved?.edited_at).not.toBeNull();
    expect(saved?.version).toBe(2);

    // The next save sends the version the row was rendered with.
    await openEdit(result.user, id);

    // Simulate a concurrent edit from another device between open and save.
    const serverVersion = saved!;
    serverVersion.text = 'Версия с другого устройства';
    serverVersion.version = 3;
    serverVersion.edited_at = new Date().toISOString();
    const second = await screen.findByRole('dialog', { name: 'Редактировать сообщение' });
    const secondInput = within(second).getByLabelText('Редактировать сообщение');
    await result.user.clear(secondInput);
    await result.user.type(secondInput, 'Мой черновик');
    await result.user.click(within(second).getByRole('button', { name: 'Сохранить' }));

    const conflictAlert = await within(second).findByRole('alert');
    expect(conflictAlert).toHaveTextContent(/Кто-то отредактировал сообщение раньше/);
    expect(mockDb.editRequests.at(-1)?.body).toMatchObject({ version: 2 });
    // The draft is preserved and the server copy was re-read into the row.
    expect(secondInput).toHaveValue('Мой черновик');
    expect(await within(row).findByText('Версия с другого устройства')).toBeInTheDocument();
    await result.user.click(within(second).getByRole('button', { name: 'Взять актуальный текст' }));
    expect(secondInput).toHaveValue('Версия с другого устройства');
    await result.user.click(within(second).getByRole('button', { name: 'Отмена' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Редактировать сообщение' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows a server 403 without closing the dialog and keeps the draft', async () => {
    server.use(
      http.patch('*/api/v1/chats/:chatId/messages/:messageId', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'no access', request_id: 'req_edit_403' },
          { status: 403 },
        ),
      ),
    );
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const dialog = await openEdit(result.user, messageId(37));
    const textarea = within(dialog).getByLabelText('Редактировать сообщение');
    await result.user.clear(textarea);
    await result.user.type(textarea, 'Не сохранится');
    await result.user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/нет прав/i);
    expect(dialog).toBeInTheDocument();
    expect(textarea).toHaveValue('Не сохранится');
    expect(
      mockDb.chats[CHAT]!.messages.find((message) => message.id === messageId(37))?.text,
    ).not.toBe('Не сохранится');
  });

  it('applies a live message.updated from another device', async () => {
    const result = renderApp({ realtimeEnabled: true });
    stores.push(result.store);
    await waitForOnline(result.store);
    const id = messageId(37);
    const row = rowFor(id);
    const serverMessage = mockDb.chats[CHAT]!.messages.find((message) => message.id === id)!;
    serverMessage.text = 'Правка с другого устройства';
    serverMessage.version = 2;
    serverMessage.edited_at = new Date().toISOString();

    act(() => publishMockMessageUpdated(mockDb, serverMessage));

    expect(await within(row).findByText('Правка с другого устройства')).toBeInTheDocument();
    expect(within(row).getByText('изменено')).toBeInTheDocument();
    expect(
      result.store.getSnapshot().slices[CHAT]?.messages.find((message) => message.id === id)
        ?.version,
    ).toBe(2);
  });

  it('hides edit for other authors and honestly disables it for stickers', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const peer = rowFor(messageId(35));
    expect(
      within(peer).queryByRole('button', { name: 'Редактировать сообщение' }),
    ).not.toBeInTheDocument();

    const sticker = rowFor(messageId(34));
    const stickerEdit = within(sticker).getByRole('button', { name: 'Редактировать сообщение' });
    expect(stickerEdit).toBeDisabled();
    expect(stickerEdit).toHaveAttribute('title', 'Можно редактировать только текстовые сообщения');

    // Empty input never reaches the API.
    const id = messageId(37);
    const dialog = await openEdit(result.user, id);
    const textarea = within(dialog).getByLabelText('Редактировать сообщение');
    await result.user.clear(textarea);
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(mockDb.editRequests).toHaveLength(0);
  });
});

describe('#63 delete', () => {
  it('deletes for me only after the server confirms and removes the row', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const id = messageId(35);
    expect(rowFor(id)).toBeInTheDocument();

    const menu = await openDeleteMenu(result.user, id);
    expect(within(menu).queryByRole('button', { name: /Удалить у всех/ })).not.toBeInTheDocument();
    await result.user.click(within(menu).getByRole('button', { name: /Удалить у себя/ }));

    await waitFor(() => {
      expect(document.getElementById(`message-${id}`)).toBeNull();
    });
    expect(mockDb.chats[CHAT]!.hiddenMessageIds.has(id)).toBe(true);
    expect(mockDb.deleteRequests.at(-1)).toMatchObject({ messageId: id, scope: 'me' });
    expect(
      mockDb.chats[CHAT]!.messages.find((message) => message.id === id)?.deleted_at,
    ).toBeNull();
  });

  it('confirms delete-for-all, stays non-optimistic and applies a cleared tombstone', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const id = messageId(37);
    const row = rowFor(id);
    const original = row.querySelector('.msg-text')?.textContent ?? '';
    expect(within(row).getByRole('button', { name: /🎉: 4, ваша реакция/ })).toBeInTheDocument();

    const menu = await openDeleteMenu(result.user, id);
    await result.user.click(within(menu).getByRole('button', { name: /Удалить у всех/ }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Удалить сообщение для всех?',
    });

    // Nothing is deleted before the explicit confirmation (no optimistic all).
    expect(row.querySelector('.msg-text')?.textContent).toBe(original);
    expect(mockDb.deleteRequests).toHaveLength(0);
    await result.user.click(within(confirm).getByRole('button', { name: 'Удалить у всех' }));

    expect(await within(row).findByText('Сообщение удалено')).toBeInTheDocument();
    expect(row.querySelector('.msg-text')).toHaveClass('msg-text--deleted');
    expect(row.querySelector('.msg-reactions')).toBeNull();
    const saved = mockDb.chats[CHAT]!.messages.find((message) => message.id === id);
    expect(saved?.deleted_at).not.toBeNull();
    expect(saved?.text).toBeNull();
    expect(saved?.reactions).toEqual([]);
    expect(mockDb.deleteRequests.at(-1)).toMatchObject({ messageId: id, scope: 'all' });
  });

  it('shows a server 403 for delete-for-all and keeps the content', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const id = messageId(37);
    const row = rowFor(id);
    const original = row.querySelector('.msg-text')?.textContent ?? '';

    const menu = await openDeleteMenu(result.user, id);
    await result.user.click(within(menu).getByRole('button', { name: /Удалить у всех/ }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Удалить сообщение для всех?',
    });
    mockDb.forceDeleteError = { status: 403, code: 'FORBIDDEN', message: 'no access' };
    await result.user.click(within(confirm).getByRole('button', { name: 'Удалить у всех' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/нет прав/i);
    expect(confirm).toBeInTheDocument();
    expect(row.querySelector('.msg-text')?.textContent).toBe(original);
    expect(
      mockDb.chats[CHAT]!.messages.find((message) => message.id === id)?.deleted_at,
    ).toBeNull();
  });

  it('guards delete-for-all for non-authors without calling the API', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const ok = await result.store.deleteMessage(CHAT, messageId(35), 'all');
    expect(ok).toBe(false);
    expect(mockDb.deleteRequests).toHaveLength(0);
    expect(result.store.getSnapshot().slices[CHAT]?.actionError?.error.code).toBe('FORBIDDEN');
  });
});

describe('E2EE honesty', () => {
  it('disables reactions/edit in an E2EE chat and never calls the metadata API', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);

    const row = rowFor(messageId(37));
    const reaction = within(row).getByRole('button', {
      name: 'Реакции недоступны в E2EE-чате',
    });
    expect(reaction).toBeDisabled();
    const edit = within(row).getByRole('button', { name: 'Редактировать сообщение' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Редактирование недоступно в E2EE-чате');
    // Delete remains available: the contract deletes E2EE via the tombstone path.
    expect(within(row).getByRole('button', { name: 'Удалить сообщение' })).toBeEnabled();

    const ok = await result.store.addReaction(CHAT, messageId(37), '👍');
    expect(ok).toBe(false);
    expect(mockDb.reactionRequests).toHaveLength(0);
    expect(result.store.getSnapshot().slices[CHAT]?.actionError?.error.code).toBe(
      'E2EE_METADATA_FORBIDDEN',
    );
  });

  it('ignores E2EE reaction/update frames and applies only the delete tombstone', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const result = renderApp({ realtimeEnabled: true });
    stores.push(result.store);
    await waitForOnline(result.store);
    const id = messageId(37);
    const row = rowFor(id);

    act(() => publishMockReactionChanged(mockDb, CHAT, id, IDS.mark, '👍', 'ADDED', 1));
    act(() =>
      publishMockMessageUpdated(
        mockDb,
        mockDb.chats[CHAT]!.messages.find((m) => m.id === id)!,
      ),
    );
    expect(row.querySelector('.msg-reactions')).toBeNull();

    act(() => publishMockMessageDeleted(mockDb, CHAT, id, new Date().toISOString(), IDS.user));
    await waitFor(() => {
      const saved = result.store.getSnapshot().slices[CHAT]?.messages.find((m) => m.id === id);
      expect(saved?.deleted_at).toBeTruthy();
    });
    expect(await within(row).findByText('Сообщение удалено')).toBeInTheDocument();
    expect(row.querySelector('.msg-text')).toHaveClass('msg-text--deleted');
  });
});

describe('keyboard and a11y', () => {
  it('opens the edit dialog from the keyboard, closes on Escape and restores focus', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(37));
    const trigger = within(row).getByRole('button', { name: 'Редактировать сообщение' });
    trigger.focus();
    await result.user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Редактировать сообщение' });
    const textarea = within(dialog).getByLabelText('Редактировать сообщение');
    expect(textarea).toHaveFocus();

    await result.user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Редактировать сообщение' }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it('closes the reaction picker on Escape and returns focus to the trigger', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(37));
    const trigger = within(row).getByRole('button', { name: 'Поставить реакцию' });
    trigger.focus();
    await result.user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Выберите реакцию' });
    await result.user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Выберите реакцию' })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it('passes an axe audit with the reaction picker and edit dialog open', async () => {
    const result = renderApp();
    stores.push(result.store);
    await waitForChat(result.store);
    const row = rowFor(messageId(37));

    await result.user.click(within(row).getByRole('button', { name: 'Поставить реакцию' }));
    await screen.findByRole('dialog', { name: 'Выберите реакцию' });
    let results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);

    await result.user.keyboard('{Escape}');
    await result.user.click(within(row).getByRole('button', { name: 'Редактировать сообщение' }));
    await screen.findByRole('dialog', { name: 'Редактировать сообщение' });
    results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });
});
