import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  GROUP_CHAT_NAME,
  disableAnimations,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  openDashboard,
} from './d1-helpers';

/**
 * D1-QA1: threads on the mock backend. Root → panel → reply → count, modal
 * close/Esc/focus and the 390 px sheet (managed chat; E2EE flag is off).
 */

const ROOT_44 = '00000000-0000-4000-8000-000000000044';
const ROOT_45 = '00000000-0000-4000-8000-000000000045';

function rootRow(page: Page, id: string) {
  return page.locator(`#message-${id}`);
}

async function openEmptyThread(
  page: Page,
  rootId: string,
): Promise<{ row: ReturnType<typeof rootRow>; trigger: Locator }> {
  const row = rootRow(page, rootId);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const trigger = row.getByRole('button', { name: /Начать тред/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Тред' })).toBeVisible();
  return { row, trigger };
}

test.describe('D1 threads', () => {
  test('root → panel → reply → count', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);

    const { row } = await openEmptyThread(page, ROOT_44);
    const dialog = page.getByRole('dialog', { name: 'Тред' });
    await expect(dialog.getByText('Пока нет ответов')).toBeVisible();
    await expect(dialog.getByRole('log', { name: 'Ответы в треде' })).toBeVisible();

    const composer = dialog.getByLabel('Ответ в тред');
    await composer.fill('Первый ответ из e2e');
    await dialog.getByRole('button', { name: 'Отправить ответ' }).click();

    await expect(dialog.getByText('Первый ответ из e2e')).toBeVisible();
    const link = row.getByRole('button', { name: 'Открыть тред, ответов: 1' });
    await expect(link).toBeVisible();
    await expect(link).toContainText('1 ответ');

    // The reply stays out of the main feed: it is visible only inside the
    // panel and as the root preview.
    const mainBubbles = page.locator('.messages .msg-text');
    await expect(mainBubbles.filter({ hasText: 'Первый ответ из e2e' })).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

  test('close button, Escape and focus return to the thread trigger', async ({ page }) => {
    await openDashboard(page);
    const { trigger } = await openEmptyThread(page, ROOT_45);
    const dialog = page.getByRole('dialog', { name: 'Тред' });
    const close = dialog.getByRole('button', { name: 'Закрыть тред' });
    await expect(close).toBeFocused();

    // Tab stays inside the modal.
    for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('.thread-panel');
      return panel ? panel.contains(document.activeElement) : false;
    });
    expect(inside).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Тред' })).toBeHidden();
    await expect(trigger).toBeFocused();

    // The explicit close control behaves the same way.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Закрыть тред' }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('390 px: thread is a full-screen sheet, Esc returns to the channel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
    await disableAnimations(page);
    await expectNoHorizontalScroll(page);

    const { trigger } = await openEmptyThread(page, ROOT_44);
    const dialog = page.getByRole('dialog', { name: 'Тред' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeLessThanOrEqual(1);
      expect(box.width).toBeGreaterThanOrEqual(388);
    }
    await expect(dialog.getByRole('button', { name: 'Назад' })).toBeVisible();
    await expect(dialog.getByLabel('Ответ в тред')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: GROUP_CHAT_NAME })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
