import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { FileItem } from '../api/types';
import { IDS } from '../mocks/fixtures';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';

const GROUP = IDS.groupChat;
const UNBOUND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOUND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fileItem(id: string, filename: string, bound = false): FileItem {
  return {
    id,
    filename,
    size_bytes: 2048,
    mime_type: 'application/pdf',
    scan_status: 'CLEAN',
    chat_id: bound ? GROUP : null,
    chat_name: bound ? 'Команда «Восход»' : null,
    message_id: bound ? '00000000-0000-4000-8000-bbbbbbbbbbbb' : null,
    created_at: '2026-11-18T10:00:00.000Z',
  };
}

async function openFiles(user: ReturnType<typeof renderApp>['user']) {
  await screen.findByRole('heading', { name: 'Команда «Восход»' });
  await user.click(screen.getByRole('button', { name: 'Файлы' }));
  await screen.findByRole('heading', { name: 'Файлы' });
}

describe('#83 global file center upload/rename/delete', () => {
  it('uploads a file as multipart, shows progress/done and refreshes the list', async () => {
    const { user } = renderApp();
    await openFiles(user);

    mockDb.fileDelayMs = 300;
    const file = new File([new Uint8Array(64)], 'roadmap.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Выбрать файл'), file);

    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(
      await screen.findByText('Файл «roadmap.pdf» загружен и поставлен на проверку.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('roadmap.pdf')).toBeInTheDocument();
    expect(mockDb.fileUploadRequests).toEqual([
      { workspaceId: IDS.workspace, filename: 'roadmap.pdf', size: 64, mime: 'application/pdf' },
    ]);
    expect(mockDb.fileCenterRequests.at(-1)).toMatchObject({ workspace_id: IDS.workspace });
  });

  it('renames only the display name and surfaces a server error honestly', async () => {
    mockDb.fileCenterItems = [fileItem(UNBOUND_ID, 'old-name.pdf')];
    const { user } = renderApp();
    await openFiles(user);

    expect(await screen.findByText('old-name.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Переименовать: old-name.pdf' }));
    const input = screen.getByLabelText('Переименовать');
    await user.clear(input);
    await user.type(input, 'new-name.pdf');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText('new-name.pdf')).toBeInTheDocument();
    expect(mockDb.fileRenameRequests.at(-1)).toMatchObject({
      fileId: UNBOUND_ID,
      name: 'new-name.pdf',
    });
    expect(mockDb.fileRenameRequests.at(-1)?.idempotencyKey).toBeTruthy();

    mockDb.forceFileRenameError = {
      status: 404,
      code: 'NOT_FOUND',
      message: 'File not found',
    };
    await user.click(screen.getByRole('button', { name: 'Переименовать: new-name.pdf' }));
    const second = screen.getByLabelText('Переименовать');
    await user.clear(second);
    await user.type(second, 'denied.pdf');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Переименовать файл может только его владелец.',
    );
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByText('new-name.pdf')).toBeInTheDocument();
  });

  it('confirms deletion, blocks an attached file with 409 and is axe-clean', async () => {
    mockDb.fileCenterItems = [
      fileItem(UNBOUND_ID, 'draft.pdf'),
      fileItem(BOUND_ID, 'attached.pdf', true),
    ];
    mockDb.limits.usage.used = 4096;
    const { user } = renderApp();
    await openFiles(user);

    await user.click(await screen.findByRole('button', { name: 'Удалить: draft.pdf' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить файл?' });
    expect(
      within(dialog).getByText('Файл «draft.pdf» будет удалён из пространства и хранилища.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(screen.queryByText('draft.pdf')).toBeNull());
    expect(mockDb.fileDeleteRequests.at(-1)?.fileId).toBe(UNBOUND_ID);
    expect(mockDb.limits.usage.used).toBe(2048);

    await user.click(screen.getByRole('button', { name: 'Удалить: attached.pdf' }));
    const boundDialog = await screen.findByRole('dialog', { name: 'Удалить файл?' });
    await user.click(within(boundDialog).getByRole('button', { name: 'Удалить' }));
    expect(
      await screen.findByText('Файл привязан к сообщению — удаление невозможно.'),
    ).toBeInTheDocument();
    expect(screen.getByText('attached.pdf')).toBeInTheDocument();

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });

  it('reports an unsupported dangerous type without adding a row', async () => {
    mockDb.forceWorkspaceUploadError = {
      status: 422,
      code: 'DANGEROUS_TYPE_BLOCKED',
      message: 'Blocked',
    };
    const { user } = renderApp();
    await openFiles(user);
    const file = new File([new Uint8Array(4)], 'payload.exe');
    await user.upload(screen.getByLabelText('Выбрать файл'), file);
    expect(
      await screen.findByText('Такой тип файла заблокирован политикой безопасности.'),
    ).toBeInTheDocument();
    expect(mockDb.fileCenterItems).toHaveLength(0);
  });
});
