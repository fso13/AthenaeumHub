import { expect, test, type Page } from '@playwright/test';
import {
  GROUP_CHAT_NAME,
  disableAnimations,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  openDashboard,
} from './d1-helpers';

/**
 * #61–#63: reactions, edit and delete on the mock backend. Own message 37
 * (seeded 🎉 aggregate); peer message 35 for delete-for-me.
 */
const OWN_29 = '00000000-0000-4000-8000-000000000029';
const PEER_27 = '00000000-0000-4000-8000-000000000027';

function row(page: Page, id: string) {
  return page.locator(`#message-${id}`);
}

async function hoverRow(page: Page, id: string) {
  const target = row(page, id);
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  return target;
}

test.describe('D1 message actions', () => {
  test('reaction picker toggles count/me and passes axe', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);
    const target = await hoverRow(page, OWN_29);

    await expectNoA11yViolations(page);
    await target.getByRole('button', { name: 'Поставить реакцию' }).click();
    const picker = page.getByRole('dialog', { name: 'Выберите реакцию' });
    await expect(picker).toBeVisible();

    await picker.getByRole('button', { name: '👍', exact: true }).click();
    const chip = target.getByRole('button', { name: /👍: 1, ваша реакция/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toContainText('1');

    await chip.click();
    await expect(target.getByRole('button', { name: /👍/ })).toHaveCount(0);

    // The seeded server aggregate is still there and untouched.
    await expect(target.locator('.msg-reactions')).toHaveCount(0);
  });

  test('edits own text with save/cancel and shows the edited marker', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);
    const target = await hoverRow(page, OWN_29);

    await target.getByRole('button', { name: 'Редактировать сообщение' }).click();
    const dialog = page.getByRole('dialog', { name: 'Редактировать сообщение' });
    await expect(dialog).toBeVisible();
    await expectNoA11yViolations(page);

    const input = dialog.getByLabel('Редактировать сообщение');
    await input.fill('Изменённый текст e2e');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();

    await expect(target.getByText('Изменённый текст e2e')).toBeVisible();
    const marker = target.getByText('изменено');
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute('title', /Изменено \d{2}\.\d{2}\.\d{4}/);

    // Cancel restores nothing and keeps the saved text.
    await target.getByRole('button', { name: 'Редактировать сообщение' }).click();
    const again = page.getByRole('dialog', { name: 'Редактировать сообщение' });
    await again.getByRole('button', { name: 'Отмена' }).click();
    await expect(again).toBeHidden();
    await expect(target.getByText('Изменённый текст e2e')).toBeVisible();
  });

  test('delete me and delete all (confirm, no optimistic content loss)', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);

    const peer = await hoverRow(page, PEER_27);
    await peer.getByRole('button', { name: 'Удалить сообщение' }).click();
    const peerMenu = page.getByRole('dialog', { name: 'Удалить сообщение' });
    await expect(peerMenu).toBeVisible();
    await expect(peerMenu.getByRole('button', { name: /Удалить у всех/ })).toHaveCount(0);
    await peerMenu.getByRole('button', { name: /Удалить у себя/ }).click();
    await expect(row(page, PEER_27)).toHaveCount(0);

    const own = await hoverRow(page, OWN_29);
    // Add a reaction first: delete-for-all must clear the aggregate chips.
    await own.getByRole('button', { name: 'Поставить реакцию' }).click();
    const picker = page.getByRole('dialog', { name: 'Выберите реакцию' });
    await picker.getByRole('button', { name: '👍', exact: true }).click();
    await expect(own.getByRole('button', { name: /👍: 1, ваша реакция/ })).toBeVisible();
    const ownText = await own.locator('.msg-text').textContent();
    await own.getByRole('button', { name: 'Удалить сообщение' }).click();
    const ownMenu = page.getByRole('dialog', { name: 'Удалить сообщение' });
    await ownMenu.getByRole('button', { name: /Удалить у всех/ }).click();
    const confirm = page.getByRole('alertdialog', {
      name: 'Удалить сообщение для всех?',
    });
    await expect(confirm).toBeVisible();
    // Still visible until the explicit confirm (no optimistic delete-all).
    await expect(own.locator('.msg-text')).toHaveText(ownText ?? '');

    await confirm.getByRole('button', { name: 'Удалить у всех' }).click();
    await expect(own.getByText('Сообщение удалено')).toBeVisible();
    await expect(own.locator('.msg-text')).toHaveClass(/msg-text--deleted/);
    await expect(own.locator('.msg-reactions')).toHaveCount(0);
  });

  test('390px keeps a visible actions button and the sheet controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
    await disableAnimations(page);
    const target = row(page, OWN_29);
    await target.scrollIntoViewIfNeeded();

    const more = target.getByRole('button', { name: 'Ещё действия' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(target.getByRole('button', { name: 'Поставить реакцию' })).toBeVisible();
    await expect(target.getByRole('button', { name: 'Редактировать сообщение' })).toBeVisible();
    await expect(target.getByRole('button', { name: 'Удалить сообщение' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByRole('heading', { name: GROUP_CHAT_NAME })).toBeVisible();
  });
});
