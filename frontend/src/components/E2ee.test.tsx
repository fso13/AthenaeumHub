/**
 * E7-F5 UI states: key-change warning + explicit accept, fresh-device mode
 * alert, safety number entry and accessible rendering (axe).
 */
import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { getDeviceId } from '../auth/session';
import { insertMockMessage } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { newUuid } from '../lib/ids';
import { mockDb } from '../test/server';
import { renderApp } from '../test/renderApp';
import { createFakeE2eeBridge, makeEnvelope } from '../test/e2eeBridgeFake';
import type { E2eeChatSnapshot } from '../e2ee/app/types';
import { E2eeError } from '../e2ee/errors';
import type { SessionResetBody } from '../e2ee/session/reset';

const CHAT = IDS.groupChat;
const PEER_DEVICE = '55555555-5555-4555-8555-555555555555';
const PEER_USER = '22222222-2222-4222-8222-222222222222';

const SNAPSHOT: Partial<E2eeChatSnapshot> = {
  chatId: CHAT,
  securityMode: 'E2EE',
  modeAction: 'allow_e2ee',
  selfDeviceId: '33333333-3333-4333-8333-333333333333',
  peerDeviceIds: [PEER_DEVICE],
  devices: [
    {
      userId: PEER_USER,
      deviceId: PEER_DEVICE,
      fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      isSelf: false,
      verified: false,
      status: 'ACTIVE',
    },
  ],
  safetyNumbers: [
    {
      userId: PEER_USER,
      deviceId: PEER_DEVICE,
      display: '12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890',
      qrPayload: 'krug://verify/v1?dev1=a&fp1=b&dev2=c&fp2=d',
      verificationHash: 'a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw',
    },
  ],
};

function renderE2ee(
  snapshot: Partial<E2eeChatSnapshot> = {},
  serverMode: 'E2EE' | 'MANAGED' = 'E2EE',
) {
  mockDb.chats[CHAT]!.summary.security_mode = serverMode;
  const bridge = createFakeE2eeBridge({
    deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
    snapshot: { ...SNAPSHOT, ...snapshot },
  });
  const result = renderApp({}, { enabled: true, bridge });
  return { ...result, bridge };
}

describe('E2EE UI states', () => {
  it('shows the key-change warning and sends nothing until the user accepts', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: {
        ...SNAPSHOT,
        keyChanges: [
          {
            userId: PEER_USER,
            deviceId: PEER_DEVICE,
            pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            detectedAt: 1,
          },
        ],
      },
    });
    renderApp({}, { enabled: true, bridge });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(await screen.findByText('Ключ безопасности изменился')).toBeInTheDocument();
    const textarea = screen.getByLabelText('Текст сообщения');
    await waitFor(() => expect(screen.getByLabelText('Отправить сообщение')).toBeDisabled());
    expect(textarea).toBeEnabled();

    await import('@testing-library/user-event').then(async ({ default: userEvent }) => {
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Принять новый ключ' }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Ключ безопасности изменился')).not.toBeInTheDocument();
    });
    expect(bridge.accepted).toEqual([{ userId: PEER_USER, deviceId: PEER_DEVICE }]);
  });

  it('blocks a MANAGED downgrade with an alert and offers no plaintext send', async () => {
    const { bridge } = renderE2ee(
      {
        securityMode: 'MANAGED',
        modeAction: 'block_security_alert',
        evidence: ['peer_has_e2ee_capable_devices'],
        peerDeviceIds: [PEER_DEVICE],
      },
      'MANAGED',
    );
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(await screen.findByText('Возможна атака на режим чата')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Отправить сообщение')).toBeDisabled());
    expect(bridge.confirmedManaged).toHaveLength(0);
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('renders the per-device safety number dialog from locally pinned keys', async () => {
    const { bridge } = renderE2ee();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(await screen.findByRole('button', { name: 'Безопасность' }));

    const dialog = await screen.findByRole('dialog', { name: 'Код безопасности' });
    expect(within(dialog).getByText(/12345 67890 12345/)).toBeInTheDocument();
    expect(within(dialog).getByText('Устройство 55555555')).toBeInTheDocument();
    expect(within(dialog).getByText('Не сверено')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Хеш сверки: a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw'),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Сверить' }));
    await waitFor(() => expect(within(dialog).getByText('Сверено')).toBeInTheDocument());
    expect(bridge.verifications).toEqual([
      { chatId: CHAT, deviceId: PEER_DEVICE, method: 'MANUAL' },
    ]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('requires re-verification and offers no verify action on a key change', async () => {
    renderE2ee({
      keyChanges: [
        {
          userId: PEER_USER,
          deviceId: PEER_DEVICE,
          pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          detectedAt: 1,
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(await screen.findByRole('button', { name: 'Безопасность' }));

    const dialog = await screen.findByRole('dialog', { name: 'Код безопасности' });
    expect(within(dialog).getByText('Нужна повторная сверка')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Сверить' })).not.toBeInTheDocument();
  });

  it('blocks E2EE and explains an unsupported browser (RFC 8032 floor)', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: { ...SNAPSHOT },
    });
    bridge.initialize = async () => {
      throw new E2eeError('E2EE_UNSUPPORTED_BROWSER', 'WebKit does not reproduce RFC 8032');
    };
    const { store } = renderApp({}, { enabled: true, bridge });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(await screen.findByText(/не прошёл проверку Ed25519 \(RFC 8032\)/)).toBeInTheDocument();
    await waitFor(() => expect(store.getSnapshot().e2ee.browserUnsupported).toBe(true));
    await waitFor(() => expect(screen.getByLabelText('Отправить сообщение')).toBeDisabled());

    await store.send(CHAT, 'не должно уйти');
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('renders an incoming E2EE message from the decrypted view, not server text', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'подмена сервера');
    incoming.text = null;
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, SNAPSHOT.selfDeviceId as string);

    renderE2ee();
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    expect(await screen.findByText('расшифровано')).toBeInTheDocument();
    expect(screen.queryByText('подмена сервера')).not.toBeInTheDocument();
  });

  it('never renders server plaintext in an E2EE chat when the flag is off', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const spoof = insertMockMessage(mockDb, CHAT, 'СЕРВЕРНЫЙ_SPOOF_FLAG_OFF');
    renderApp({}, null);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await waitFor(() => expect(document.getElementById(`message-${spoof.id}`)).not.toBeNull());
    expect(screen.queryByText('СЕРВЕРНЫЙ_SPOOF_FLAG_OFF')).not.toBeInTheDocument();
  });

  it('never renders server plaintext when E2EE initialization failed', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const spoof = insertMockMessage(mockDb, CHAT, 'СЕРВЕРНЫЙ_SPOOF_INIT_ERROR');
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: { ...SNAPSHOT },
    });
    bridge.initialize = async () => {
      throw new Error('init failed for the plaintext-spoof test');
    };
    renderApp({}, { enabled: true, bridge });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await waitFor(() => expect(document.getElementById(`message-${spoof.id}`)).not.toBeNull());
    expect(screen.queryByText('СЕРВЕРНЫЙ_SPOOF_INIT_ERROR')).not.toBeInTheDocument();
  });

  it('hides server reply, sticker and attachment payloads in an E2EE chat', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const original = insertMockMessage(mockDb, CHAT, 'SERVER_REPLY_TARGET_SPOOF');
    const row = insertMockMessage(mockDb, CHAT, 'SERVER_TEXT_SPOOF');
    row.reply_to_id = original.id;
    row.sticker = {
      id: '12121212-1212-4212-8212-121212121212',
      pack_id: '13131313-1313-4313-8313-131313131313',
      alt: 'SERVER_STICKER_SPOOF',
      url: 'https://server.invalid/SERVER_STICKER_SPOOF.png',
      favorite: false,
    };
    row.attachments = [
      {
        id: '14141414-1414-4414-8414-141414141414',
        filename: 'SERVER_ATTACHMENT_SPOOF.txt',
        size_bytes: 1,
        mime_type: 'text/plain',
        scan_status: 'CLEAN',
      },
    ];
    row.crypto = makeEnvelope(CHAT, PEER_DEVICE, SNAPSHOT.selfDeviceId as string);

    renderApp({}, null);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await waitFor(() => expect(document.getElementById(`message-${row.id}`)).not.toBeNull());

    expect(screen.queryByText('SERVER_TEXT_SPOOF')).not.toBeInTheDocument();
    expect(screen.queryByText('SERVER_REPLY_TARGET_SPOOF')).not.toBeInTheDocument();
    expect(screen.queryByText('SERVER_STICKER_SPOOF')).not.toBeInTheDocument();
    expect(screen.queryByText(/SERVER_ATTACHMENT_SPOOF/)).not.toBeInTheDocument();
    expect(document.querySelector('img[alt="SERVER_STICKER_SPOOF"]')).toBeNull();
  });

  it('treats a crypto chat downgraded to MANAGED as E2EE when the flag is off', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'MANAGED';
    const spoof = insertMockMessage(mockDb, CHAT, 'DOWNGRADE_SERVER_TEXT_SPOOF');
    spoof.crypto = makeEnvelope(CHAT, PEER_DEVICE, SNAPSHOT.selfDeviceId as string);

    const { store } = renderApp({}, null);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await waitFor(() => store.getSnapshot().slices[CHAT]?.status === 'ready');
    await waitFor(() => expect(document.getElementById(`message-${spoof.id}`)).not.toBeNull());

    await waitFor(() => expect(store.isE2eeChat(CHAT)).toBe(true));
    expect(store.e2eeBlockReason(CHAT)).toBe('flag_disabled');
    expect(screen.queryByText('DOWNGRADE_SERVER_TEXT_SPOOF')).not.toBeInTheDocument();

    await store.send(CHAT, 'плоский текст не должен уйти');
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('never shows the server reply quote in the E2EE composer', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const spoof = insertMockMessage(mockDb, CHAT, 'COMPOSER_REPLY_SPOOF');
    spoof.crypto = makeEnvelope(CHAT, PEER_DEVICE, SNAPSHOT.selfDeviceId as string);

    renderApp({}, null);
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    const article = await waitFor(() => {
      const element = document.getElementById(`message-${spoof.id}`);
      if (element === null) throw new Error('message row is not rendered yet');
      return element;
    });

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(within(article).getByRole('button', { name: /Ответить/ }));

    const replyBar = document.querySelector('.reply-bar__text');
    expect(replyBar).not.toBeNull();
    expect(replyBar?.textContent).not.toContain('COMPOSER_REPLY_SPOOF');
    expect(replyBar?.textContent).toContain('Исходное сообщение не загружено');
  });

  it('shows one retry-progress banner, a retry action and the completion state', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const control = insertMockMessage(mockDb, CHAT, 'RESET_CONTROL_ROW_MUST_BE_HIDDEN');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, SNAPSHOT.selfDeviceId as string);

    const reset: SessionResetBody = {
      failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      failedN: 0,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
    };

    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: { ...SNAPSHOT },
    });
    bridge.receiveQueue.push({
      kind: 'control',
      sessionId: reset.failedSessionId,
      reset,
      senderDeviceId: PEER_DEVICE,
    });
    bridge.resetOutcome = {
      status: 'pending',
      failedSessionId: reset.failedSessionId,
      candidates: [
        {
          originalClientMessageId: reset.retryOfClientMessageId as string,
          originalServerMessageId: null,
          text: 'переотправить меня',
          replyToId: null,
        },
      ],
      remaining: 0,
      skipped: 0,
    };
    let failRetry = true;
    const normalSend = bridge.sendText.bind(bridge);
    bridge.sendText = async (input) => {
      if (failRetry) throw new Error('retry batch failed for UI test');
      return normalSend(input);
    };

    renderApp({}, { enabled: true, bridge });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });

    expect(await screen.findByText(/Не удалось переотправить часть сообщений/)).toBeInTheDocument();
    expect(screen.queryByText('RESET_CONTROL_ROW_MUST_BE_HIDDEN')).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Повторить переотправку' });
    expect(screen.getAllByRole('button', { name: 'Повторить переотправку' })).toHaveLength(1);

    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let audit;
    try {
      audit = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    } finally {
      canvas.getContext = originalGetContext;
    }
    expect(
      audit.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);

    failRetry = false;
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(retry);

    expect(await screen.findByText('Сообщения переотправлены в новую сессию.')).toBeInTheDocument();
    await waitFor(() => expect(mockDb.sendAttempts).toHaveLength(1));
    expect(
      screen.queryByRole('button', { name: 'Повторить переотправку' }),
    ).not.toBeInTheDocument();
  });

  it('lists uncovered peer devices after a send with a coverage warning', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: { ...SNAPSHOT },
    });
    const normalSend = bridge.sendText.bind(bridge);
    bridge.sendText = async (input) => {
      const prepared = await normalSend(input);
      return {
        ...prepared,
        coverageWarning: 'PEER_DEVICE_UNCOVERED',
        coverage: {
          ...prepared.coverage,
          covered: 0,
          peerCovered: 0,
          uncoveredDeviceIds: [PEER_DEVICE],
        },
      };
    };
    const { store } = renderApp({}, { enabled: true, bridge });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await waitFor(() => store.e2eeBlockReason(CHAT) === null);

    await store.send(CHAT, 'coverage');
    expect(
      await screen.findByText('Не все устройства собеседника получили сообщение.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Устройство 55555555')).toBeInTheDocument();
  });

  it('passes an axe audit for the key-change state and the safety dialog', async () => {
    renderE2ee({
      keyChanges: [
        {
          userId: PEER_USER,
          deviceId: PEER_DEVICE,
          pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          detectedAt: 1,
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Команда «Восход»' });
    await screen.findByText('Ключ безопасности изменился');

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(await screen.findByRole('button', { name: 'Безопасность' }));
    await screen.findByRole('dialog', { name: 'Код безопасности' });

    // jsdom has no canvas; axe probes it for icon-ligature detection only.
    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (...args: unknown[]) => unknown;
    };
    const originalGetContext = canvas.getContext;
    canvas.getContext = () => null;
    let results;
    try {
      results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
    } finally {
      canvas.getContext = originalGetContext;
    }
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
    expect(await screen.findByRole('dialog', { name: 'Код безопасности' })).toBeInTheDocument();
  });
});
