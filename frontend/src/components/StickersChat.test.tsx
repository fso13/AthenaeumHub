import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatStore } from '../store/chatStore';
import { builtinSticker, IDS, STICKER_PACK_IDS } from '../mocks/fixtures';
import { mockDb, server } from '../test/server';
import { renderApp } from '../test/renderApp';

const stores: ChatStore[] = [];

async function renderStickers() {
  const result = renderApp();
  stores.push(result.store);
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await waitFor(() => {
    expect(result.container.querySelectorAll('.msg-row').length).toBeGreaterThan(0);
  });
  return result;
}

async function openPicker(user: ReturnType<typeof renderApp>['user'], waitForTab = 'Pickle') {
  await user.click(screen.getByRole('button', { name: 'Стикеры' }));
  const dialog = await screen.findByRole('dialog', { name: 'Стикеры' });
  await screen.findByRole('tab', { name: waitForTab });
  return dialog;
}

async function selectPack(
  user: ReturnType<typeof renderApp>['user'],
  name = 'Pickle',
): Promise<void> {
  await user.click(screen.getByRole('tab', { name }));
}

function apiError(status: number, code: string) {
  return HttpResponse.json(
    { code, message: code, request_id: 'req-test' },
    { status, headers: { 'X-Request-Id': 'req-test' } },
  );
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe('built-in stickers in managed chat', () => {
  it('renders a sticker from history as a 512px image without a bubble', async () => {
    await renderStickers();

    const image = await screen.findByRole('img', { name: 'Pickle: готово' });
    expect(image).toHaveAttribute('src', '/stickers/krug/03.png');
    expect(image).toHaveAttribute('width', '512');
    expect(image).toHaveAttribute('height', '512');
    expect(image.closest('.bubble')).toBeNull();
    expect(image.closest('.sticker-message')).not.toBeNull();
  });

  it('opens the picker, searches by alt, sends STICKER optimistically and records recent', async () => {
    const { user, container } = await renderStickers();
    await openPicker(user);
    await selectPack(user);

    const search = screen.getByLabelText('Поиск по стикерам');
    await user.type(search, 'спасибо');
    expect(screen.getByRole('button', { name: 'Отправить стикер: Pickle: спасибо' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Отправить стикер: Pickle: привет' })).toBeNull();
    await user.clear(search);

    mockDb.sendDelayMs = 150;
    const sticker = builtinSticker('krug', 1);
    await user.click(screen.getByRole('button', { name: 'Отправить стикер: Pickle: спасибо' }));

    const optimistic = await screen.findByRole('img', { name: 'Pickle: спасибо' });
    expect(optimistic.closest('.bubble')).toBeNull();
    expect(screen.getByText('Отправляется…')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByText('Отправляется…')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const sent = mockDb.chats[IDS.groupChat]?.messages.at(-1);
    expect(sent?.type).toBe('STICKER');
    expect(sent?.sticker_id).toBe(sticker.id);
    expect(sent?.sticker?.alt).toBe('Pickle: спасибо');
    expect(sent?.text).toBeNull();
    expect(mockDb.sendBodies[0]).toMatchObject({
      type: 'STICKER',
      sticker_id: sticker.id,
    });
    expect(screen.getAllByRole('img', { name: 'Pickle: спасибо' })).toHaveLength(1);
    expect(container.querySelectorAll('.sticker-message__image').length).toBeGreaterThan(0);

    await openPicker(user);
    await user.click(screen.getByRole('tab', { name: 'Недавние' }));
    expect(screen.getByRole('button', { name: 'Отправить стикер: Pickle: спасибо' })).toBeVisible();
  });

  it('favorites and unfavorites with optimistic PUT/DELETE and shows the favorite tab', async () => {
    const { user } = await renderStickers();
    await openPicker(user);
    await selectPack(user);

    const sticker = builtinSticker('krug', 0);
    const add = screen.getByRole('button', { name: 'Добавить в избранное: Pickle: привет' });
    await user.click(add);

    await waitFor(() => {
      expect(mockDb.stickerFavorites.has(sticker.id)).toBe(true);
    });
    expect(
      screen.getByRole('button', { name: 'Убрать из избранного: Pickle: привет' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(mockDb.stickerFavoriteRequests).toEqual([{ stickerId: sticker.id, action: 'PUT' }]);

    await user.click(screen.getByRole('tab', { name: 'Избранное' }));
    expect(screen.getByRole('button', { name: 'Отправить стикер: Pickle: привет' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Убрать из избранного: Pickle: привет' }));
    await waitFor(() => {
      expect(mockDb.stickerFavorites.has(sticker.id)).toBe(false);
    });
    expect(screen.getByText(/В избранном пока нет стикеров/)).toBeInTheDocument();
  });

  it('rolls the favorite back and keeps the picker usable when the server fails', async () => {
    const { user } = await renderStickers();
    server.use(http.put('*/api/v1/stickers/:stickerId/favorite', () => apiError(500, 'INTERNAL')));
    await openPicker(user);
    await selectPack(user);

    await user.click(screen.getByRole('button', { name: 'Добавить в избранное: Pickle: привет' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Сервер недоступен/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Добавить в избранное: Pickle: привет' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(mockDb.stickerFavorites.size).toBe(0);
  });

  it('blocks sending on 409 STICKER_PACK_DISABLED and hides the disabled pack', async () => {
    const { user } = await renderStickers();
    await openPicker(user);
    await selectPack(user);

    mockDb.forceSendError = {
      status: 409,
      code: 'STICKER_PACK_DISABLED',
      message: 'Sticker pack is disabled',
      details: { pack_id: STICKER_PACK_IDS.krug, status: 'DISABLED' },
    };
    await user.click(screen.getByRole('button', { name: 'Отправить стикер: Pickle: привет' }));

    expect(await screen.findByText('Набор стикеров отключён')).toBeInTheDocument();
    expect(screen.queryByText('Отправляется…')).toBeNull();
    expect(mockDb.sendBodies[0]).toMatchObject({ type: 'STICKER' });
    expect(screen.getByRole('button', { name: 'Убрать' })).toBeInTheDocument();

    await openPicker(user, 'Коты');
    expect(screen.queryByRole('tab', { name: 'Pickle' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Коты' })).toBeInTheDocument();
    expect(screen.getByText(/Набор «Pickle» отключён/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отправить стикер: Pickle: привет' })).toBeNull();
  });

  it.each([
    [404, 'STICKER_NOT_FOUND', 'Стикер недоступен'],
    [410, 'STICKER_NOT_FOUND', 'Стикер недоступен'],
    [422, 'INVALID_STICKER_MESSAGE', 'Стикер не отправлен'],
  ])('shows a non-retryable sticker error for %s %s', async (status, code, title) => {
    const { user } = await renderStickers();
    await openPicker(user);
    await selectPack(user);

    mockDb.forceSendError = { status, code, message: code };
    await user.click(screen.getByRole('button', { name: 'Отправить стикер: Pickle: привет' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(title)).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(within(alert).queryByRole('button', { name: 'Вернуть текст' })).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Убрать' })).toBeInTheDocument();
    expect(mockDb.chats[IDS.groupChat]?.messages.at(-1)?.type).not.toBe('STICKER');
  });

  it('supports keyboard tabs, grid arrows, Esc and click-outside closing', async () => {
    const { user } = await renderStickers();
    await openPicker(user);

    expect(document.activeElement).toBe(screen.getByLabelText('Поиск по стикерам'));

    const favoritesTab = screen.getByRole('tab', { name: 'Избранное' });
    await user.click(favoritesTab);
    expect(favoritesTab).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Недавние' })).toHaveAttribute('aria-selected', 'true');

    await selectPack(user);
    const first = screen.getByRole('button', { name: 'Отправить стикер: Pickle: привет' });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Отправить стикер: Pickle: спасибо' }),
    );

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Стикеры' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Стикеры' }));

    await openPicker(user);
    await user.click(screen.getByRole('heading', { name: 'Команда «Восход»' }));
    expect(screen.queryByRole('dialog', { name: 'Стикеры' })).toBeNull();
  });

  it('shows a catalog load error with retry', async () => {
    const { user } = await renderStickers();
    mockDb.forceStickerPacksError = {
      status: 500,
      code: 'INTERNAL',
      message: 'catalog failed',
    };

    await user.click(screen.getByRole('button', { name: 'Стикеры' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить стикеры')).toBeInTheDocument();

    mockDb.forceStickerPacksError = null;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('tab', { name: 'Pickle' })).toBeInTheDocument();
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ])('shows a no-access picker state for a foreign chat (%s)', async (status, code) => {
    const { user } = await renderStickers();
    server.use(http.get('*/api/v1/sticker-packs', () => apiError(status, code)));

    await user.click(screen.getByRole('button', { name: 'Стикеры' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Не удалось загрузить стикеры')).toBeInTheDocument();
    expect(within(alert).getByText('Нет доступа')).toBeInTheDocument();
    expect(within(alert).getByText(code)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Pickle' })).toBeNull();
  });

  it('keeps sticker sending compatible with reply targeting', async () => {
    const { user } = await renderStickers();
    const replyButtons = screen.getAllByRole('button', { name: /Ответить/ });
    await user.click(replyButtons[0]!);
    expect(screen.getByText(/Ответ на сообщение/)).toBeInTheDocument();

    await openPicker(user);
    await selectPack(user);
    await user.click(screen.getByRole('button', { name: 'Отправить стикер: Pickle: привет' }));

    await waitFor(() => {
      expect(mockDb.sendBodies[0]?.reply_to_id).toBeTruthy();
    });
    expect(screen.queryByText(/Ответ на сообщение/)).toBeNull();
  });
});
