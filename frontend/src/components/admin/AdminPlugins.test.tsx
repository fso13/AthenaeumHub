import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockDb } from '../../test/server';
import { seedMockPluginPackage, setMockPlatformAdmin, setMockSetupRequired } from '../../mocks/db';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD } from '../../mocks/fixtures';
import { createMockPluginZip } from '../../mocks/pluginPackage';
import { navigate } from '../../router/router';
import { renderPasswordApp } from '../../test/renderApp';

type TestUser = ReturnType<typeof renderPasswordApp>['user'];

async function loginAdmin(user: TestUser): Promise<void> {
  setMockSetupRequired(mockDb, false);
  setMockPlatformAdmin(mockDb, true);
  await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
  await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });
}

async function openAdminPlugins(): Promise<void> {
  navigate('/admin?tab=plugins');
  await screen.findByRole('heading', { name: 'Внешние плагины' });
}

describe('D1.2 admin external plugin management', () => {
  it('uploads a valid ZIP and lists the installed package', async () => {
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();

    expect(await screen.findByText('Внешних плагинов нет')).toBeVisible();
    const input = screen.getByLabelText('ZIP-пакет плагина');
    await user.upload(input, createMockPluginZip({ id: 'hello-panel', version: '1.4.0' }));
    expect(await screen.findByText(/Выбран файл: hello-panel\.zip/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Установить пакет' }));

    expect(await screen.findByText('Пакет «Hello panel» установлен.')).toBeVisible();
    expect(mockDb.pluginPackageInstallRequests).toHaveLength(1);
    expect(mockDb.pluginPackages.map((pkg) => pkg.id)).toEqual(['hello-panel']);
    const row = await screen.findByRole('listitem');
    expect(within(row).getByText('Hello panel')).toBeVisible();
    expect(within(row).getByText('hello-panel')).toBeVisible();
    expect(within(row).getByText('v1.4.0')).toBeVisible();
    expect(within(row).getByText('Чтение сообщений')).toBeVisible();
    expect(within(row).getByText('index.html')).toBeVisible();
  });

  it('shows upload progress and then a server-confirmed success', async () => {
    mockDb.pluginPackageInstallDelayMs = 300;
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();

    await user.upload(screen.getByLabelText('ZIP-пакет плагина'), createMockPluginZip());
    await user.click(screen.getByRole('button', { name: 'Установить пакет' }));

    const progress = await screen.findByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Загружаем пакет…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Установить пакет' })).toBeDisabled();

    expect(await screen.findByText('Пакет «Hello panel» установлен.')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // The picked file is cleared after the server confirms the install.
    expect(screen.queryByText(/Выбран файл/)).not.toBeInTheDocument();
  });

  it('surfaces manifest/archive errors from the contract without inventing a package', async () => {
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();
    mockDb.forceInstallPluginPackageError = {
      status: 400,
      code: 'PLUGIN_PACKAGE_INVALID',
      message: 'manifest.json is missing or invalid',
    };

    await user.upload(screen.getByLabelText('ZIP-пакет плагина'), createMockPluginZip());
    await user.click(screen.getByRole('button', { name: 'Установить пакет' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Не удалось установить пакет')).toBeVisible();
    expect(within(alert).getByText(/Сервер отклонил архив/)).toBeVisible();
    expect(mockDb.pluginPackages).toHaveLength(0);
    expect(screen.queryByText(/установлен\./)).not.toBeInTheDocument();
  });

  it('rejects an oversized ZIP before uploading', async () => {
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();
    const input = screen.getByLabelText('ZIP-пакет плагина');

    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.zip', {
      type: 'application/zip',
    });
    await user.upload(input, oversized);
    expect(await screen.findByText('ZIP больше 5 МиБ.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Установить пакет' })).toBeDisabled();
    expect(mockDb.pluginPackageInstallRequests).toHaveLength(0);
  });

  it('uninstalls after an explicit confirmation and removes the row', async () => {
    seedMockPluginPackage(mockDb, { id: 'hello-panel', name: 'Hello panel' });
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();

    const remove = await screen.findByRole('button', { name: 'Удалить пакет «Hello panel»' });
    await user.click(remove);
    const dialog = await screen.findByRole('dialog', { name: 'Удалить пакет «Hello panel»?' });
    expect(within(dialog).getByText(/Пакет будет отключён/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить пакет' }));

    expect(await screen.findByText('Пакет удалён.')).toBeVisible();
    expect(mockDb.pluginPackageUninstallRequests).toEqual(['hello-panel']);
    expect(mockDb.pluginPackages).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText('Hello panel')).not.toBeInTheDocument());
    expect(await screen.findByText('Внешних плагинов нет')).toBeVisible();
  });

  it('links to the developer documentation', async () => {
    const { user } = renderPasswordApp();
    await loginAdmin(user);
    await openAdminPlugins();

    const docs = screen.getByRole('link', { name: 'Документация для разработчиков' });
    expect(docs).toHaveAttribute(
      'href',
      'https://github.com/fso13/AthenaeumHub/blob/main/docs/PLUGIN-DEVELOPMENT.md',
    );
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps install unavailable for a non-admin even if the tab URL is opened', async () => {
    setMockSetupRequired(mockDb, false);
    setMockPlatformAdmin(mockDb, false);
    const { user } = renderPasswordApp();
    await user.type(await screen.findByLabelText('Email'), MOCK_DEMO_EMAIL);
    await user.type(screen.getByLabelText('Пароль'), MOCK_DEMO_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Команда «Восход»' });

    navigate('/admin?tab=plugins');
    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeVisible();
    expect(screen.queryByLabelText('ZIP-пакет плагина')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Установить пакет' })).not.toBeInTheDocument();
    expect(mockDb.pluginPackageInstallRequests).toHaveLength(0);
  });
});
