import { expect, test, type Page } from '@playwright/test';
import {
  disableAnimations,
  expectNoA11yViolations,
  finishUploads,
  installFakeRecorder,
  openDashboard,
  removeMediaDevices,
} from './d1-helpers';

/**
 * D1-QA1: D1 media UI — song card with ID3 tags, honest fallback without tags,
 * voice button capability state and the mocked MediaRecorder flow.
 */

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function n(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function frame(id: string, payload: number[]): number[] {
  return [...asciiBytes(id), ...n(payload.length), 0, 0, ...payload];
}

function utf8(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

/** 1×1 transparent PNG used as a real APIC cover (browser-decodable). */
const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Minimal ID3v2.4 song: text frames + a PNG APIC cover. */
function id3Song(): Buffer {
  const body = [
    ...frame('TIT2', [3, ...utf8('Полёт')]),
    ...frame('TPE1', [3, ...utf8('Аквариум')]),
    ...frame('TALB', [3, ...utf8('Радио Африка')]),
    ...frame('TYER', [3, ...utf8('1983')]),
    ...frame('TCON', [3, ...utf8('Rock')]),
    ...frame('TLEN', [3, ...utf8('180000')]),
    ...frame('APIC', [0, ...asciiBytes('image/png'), 0, 3, 0, ...COVER_PNG]),
  ];
  const tag = Buffer.from([...asciiBytes('ID3'), 4, 0, 0, ...n(body.length), ...body]);
  // One dummy MPEG frame keeps the file shaped like an audio track.
  return Buffer.concat([tag, Buffer.from([0xff, 0xfb, 0x90, 0x64])]);
}

async function uploadAndSend(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await finishUploads(page);
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByText('Готов к отправке', { exact: true })).toBeVisible();
  const composer = page.getByLabel('Текст сообщения');
  await composer.fill(name.includes('song') ? 'Песня' : 'Файл');
  await composer.press('Enter');
}

test.describe('D1 media', () => {
  test('ID3 song: title/artist/album/year/genre/duration + local cover', async ({ page }) => {
    await openDashboard(page);
    await disableAnimations(page);
    await uploadAndSend(page, 'song.mp3', 'audio/mpeg', id3Song());

    const card = page.locator('.song-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.song-card__title')).toHaveText('Полёт');
    await expect(card.locator('.song-card__artist')).toHaveText('Аквариум');
    await expect(card.locator('.song-card__meta')).toContainText('Радио Африка');
    await expect(card.locator('.song-card__meta')).toContainText('1983');
    await expect(card.locator('.song-card__meta')).toContainText('Rock');
    await expect(card.locator('.song-card__duration')).toHaveText('3:00');
    // The APIC cover is cached locally (no hosted artwork in D1 MVP).
    await expect(card.getByAltText('Обложка: Полёт')).toBeVisible();

    await expectNoA11yViolations(page);
  });

  test('MP3 without tags falls back to filename/unknown artist/default cover', async ({ page }) => {
    await openDashboard(page);
    await uploadAndSend(
      page,
      'track.mp3',
      'audio/mpeg',
      Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]),
    );

    const card = page.locator('.song-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.song-card__title')).toHaveText('track.mp3');
    await expect(card.locator('.song-card__artist')).toHaveText('Неизвестный исполнитель');
    await expect(card.locator('.song-card__cover--fallback')).toBeVisible();
  });

  test('voice button is honestly disabled without microphone access', async ({ page }) => {
    await removeMediaDevices(page);
    await openDashboard(page);

    const mic = page.getByRole('button', { name: 'Записать голосовое сообщение' });
    await expect(mic).toBeDisabled();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(mic).toHaveAttribute('title', 'Браузер не предоставляет доступ к микрофону.');
  });

  test('mocked MediaRecorder: recording state, cancel, then stop-and-send', async ({ page }) => {
    await installFakeRecorder(page);
    await openDashboard(page);
    await finishUploads(page);

    const mic = page.getByRole('button', { name: 'Записать голосовое сообщение' });
    await expect(mic).toBeEnabled();
    await mic.click();

    const bar = page.getByRole('group', { name: 'Запись голосового сообщения' });
    await expect(bar).toBeVisible();
    await expect(bar.getByText('Идёт запись')).toBeVisible();
    const timer = page.getByRole('timer');
    await expect(timer).toHaveAccessibleName(/Время записи/);
    await expect(timer).not.toHaveText('0:00');

    // Escape cancels and returns focus to the mic without uploading anything.
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
    await expect(mic).toBeFocused();

    // Record again and send the take: the mock upload pipeline finalizes it
    // and the attachment appears in the channel.
    await mic.click();
    await expect(bar.getByText('Идёт запись')).toBeVisible();
    await bar.getByRole('button', { name: 'Остановить и отправить' }).click();
    const voiceCard = page.locator('.attachment-card').filter({ hasText: /voice-.*\.webm/ });
    await expect(voiceCard).toBeVisible({ timeout: 15_000 });
  });
});
