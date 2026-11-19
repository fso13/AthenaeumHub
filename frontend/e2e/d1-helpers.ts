import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Mock fixture ids (src/mocks/fixtures.ts) used by the D1 e2e suite. */
export const GROUP_CHAT_ID = '44444444-4444-4444-8444-444444444444';
export const DIRECT_CHAT_ID = '55555555-5555-4555-8555-555555555555';
export const WORKSPACE_NAME = 'Студия «Восход»';
export const GROUP_CHAT_NAME = 'Команда «Восход»';
export const DIRECT_CHAT_NAME = 'Анна Петрова';
export const MOCK_DEMO_EMAIL = 'demo@krug.test';
export const MOCK_DEMO_PASSWORD = 'Krug-demo-2026';

export type D1WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';

interface D1MockControls {
  files: { setScanPolls(count: number): void };
  devices: { clear(): void };
}

/** Local view of the mock debug globals (declared by src/mocks/browser.ts). */
type D1Window = Window & {
  __krugMocks?: D1MockControls;
  __krugUnreadCounts?: Record<string, number>;
  __krugWorkspaceRole?: D1WorkspaceRole;
};

/**
 * Password-mode login (MSW mock backend) → dashboard. No real backend and no
 * Keycloak: the Auth BFF mock accepts the demo credentials from the fixtures.
 */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  const loginHeading = page.getByRole('heading', { name: 'Вход в Сову' });
  const chatHeading = page.getByRole('heading', { name: GROUP_CHAT_NAME });
  await expect(loginHeading.or(chatHeading)).toBeVisible();

  if (await loginHeading.isVisible()) {
    await page.getByLabel('Email').fill(MOCK_DEMO_EMAIL);
    await page.getByLabel('Пароль', { exact: true }).fill(MOCK_DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
  }

  await expect(chatHeading).toBeVisible();
}

/** Boot the mock backend with per-chat unread overrides (rail boundary tests). */
export async function setUnreadCounts(page: Page, counts: Record<string, number>): Promise<void> {
  await page.addInitScript((value) => {
    (window as D1Window).__krugUnreadCounts = value;
  }, counts);
}

/** Boot with a specific workspace role (chat-settings read-only test). */
export async function setWorkspaceRole(page: Page, role: D1WorkspaceRole): Promise<void> {
  await page.addInitScript((value) => {
    (window as D1Window).__krugWorkspaceRole = value;
  }, role);
}

/** Clear the mock device list for the honest profile empty state. */
export async function clearDevices(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as D1Window).__krugMocks?.devices.clear();
  });
}

/**
 * Navigation lives in the sidebar on desktop and in the drawer on ≤900 px.
 * Opening the drawer first keeps the same script valid at every viewport.
 */
export async function goToView(page: Page, label: string): Promise<void> {
  const menu = page.getByRole('button', { name: 'Открыть навигацию' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Разделы пространства' })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** The page shell focuses `<main>` on navigation (D1-FE1). */
export async function expectPageHeading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.locator('main#chat-main')).toBeFocused();
}

/**
 * Disable transitions/animations before axe. Contrast is measured on the
 * settled state; this replaces fixed `waitForTimeout` sleeps (no flakes).
 */
export async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;' +
      'scroll-behavior:auto!important}',
  });
}

/** WCAG 2.1 A/AA audit; a violation id and target make failures actionable. */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const violations = accessibility.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.nodes
        .slice(0, 3)
        .map((node) => `${node.target.join(' ')} — ${node.failureSummary ?? ''}`)
        .join(' | ')}`,
  );
  expect(violations).toEqual([]);
}

/** No page-level horizontal scroll at the current viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

/** Set the mock recorder/device capability before the app boots. */
export async function installFakeRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeMediaRecorder {
      static isTypeSupported(mime: string): boolean {
        return mime.startsWith('audio/webm');
      }

      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? 'audio/webm';
      }

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
        const blob = new Blob([bytes], { type: this.mimeType });
        this.ondataavailable?.({ data: blob });
        this.onstop?.();
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => undefined }],
        }),
      },
    });
  });
}

/** Boot without microphone access: the voice button must be honestly disabled. */
export async function removeMediaDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
  });
}

/** Force the mock upload scan to finish on the first poll. */
export async function finishUploads(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as D1Window).__krugMocks?.files.setScanPolls(0);
  });
}
