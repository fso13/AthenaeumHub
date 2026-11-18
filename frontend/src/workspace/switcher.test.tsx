import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, IDS } from '../mocks/fixtures';
import { setMockWorkspaces } from '../mocks/db';
import { mockDb, server } from '../test/server';
import { renderPasswordApp } from '../test/renderApp';
import { readDeviceWorkspaceId, writeDeviceWorkspaceId } from './deviceWorkspace';

const SECOND_WORKSPACE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Второе пространство',
  slug: 'second',
  role: 'MEMBER' as const,
  security_mode: 'MANAGED' as const,
};

async function loginAndLoad(user: ReturnType<typeof renderPasswordApp>['user']) {
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
}

describe('E8/R-02 workspace switcher', () => {
  it('persists only the workspace id per device and restores it after a reload', async () => {
    setMockWorkspaces(mockDb, [
      {
        id: IDS.workspace,
        name: 'Студия «Восход»',
        slug: 'studiya-voshod',
        role: 'OWNER',
        security_mode: 'MANAGED',
      },
      SECOND_WORKSPACE,
    ]);

    const first = renderPasswordApp();
    await loginAndLoad(first.user);

    const select = await screen.findByLabelText('Выбрать пространство');
    await first.user.selectOptions(select, SECOND_WORKSPACE.id);
    await waitFor(() =>
      expect(first.store.getSnapshot().activeWorkspaceId).toBe(SECOND_WORKSPACE.id),
    );

    expect(readDeviceWorkspaceId()).toBe(SECOND_WORKSPACE.id);
    // The preference is only the id; no token is exposed by the module.
    expect(readDeviceWorkspaceId()).toHaveLength(36);

    first.unmount();

    const second = renderPasswordApp();
    await waitFor(() =>
      expect(screen.getByLabelText('Выбрать пространство')).toHaveValue(SECOND_WORKSPACE.id),
    );
    expect(second.store.getSnapshot().activeWorkspaceId).toBe(SECOND_WORKSPACE.id);
    expect(screen.getAllByText(SECOND_WORKSPACE.name).length).toBeGreaterThan(0);
    second.unmount();
  });

  it('falls back to the server default when the persisted id is not a membership', async () => {
    writeDeviceWorkspaceId('99999999-9999-4999-8999-999999999999');

    const { user, store } = renderPasswordApp();
    await loginAndLoad(user);
    expect(store.getSnapshot().activeWorkspaceId).toBe(IDS.workspace);
  });

  it('resets the previous workspace chats and notification state on switch', async () => {
    setMockWorkspaces(mockDb, [
      {
        id: IDS.workspace,
        name: 'Студия «Восход»',
        slug: 'studiya-voshod',
        role: 'OWNER',
        security_mode: 'MANAGED',
      },
      SECOND_WORKSPACE,
    ]);

    const { user, store } = renderPasswordApp();
    await loginAndLoad(user);
    await waitFor(() => expect(store.getSnapshot().notifications.items.length).toBeGreaterThan(0));

    // Keep the post-switch notification fetch in flight so the assertion sees
    // the synchronous reset, not a re-populated list.
    server.use(
      http.get('*/api/v1/notifications', async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return HttpResponse.json({
          items: [],
          page: { has_more: false },
          unread_count: 0,
        });
      }),
    );

    await user.selectOptions(screen.getByLabelText('Выбрать пространство'), SECOND_WORKSPACE.id);
    await waitFor(() => expect(store.getSnapshot().activeWorkspaceId).toBe(SECOND_WORKSPACE.id));

    const state = store.getSnapshot();
    expect(state.chats).toHaveLength(0);
    expect(state.activeChatId).toBeNull();
    expect(state.slices).toEqual({});
    expect(state.notifications.items).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Команда «Восход»' })).not.toBeInTheDocument();

    // Let the delayed post-switch fetch settle before the next test resets MSW.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
