import { describe, expect, it } from 'vitest';
import {
  confirmManagedChatMode,
  deleteChatModePin,
  evaluateChatMode,
  pinChatMode,
  pinE2eeChatMode,
  readChatModePin,
} from './modePin';
import { DEVICE_IDS, makeDeviceFixture, registerFixtureDevice } from '../test/deviceFixtures';
import type { E2eeStorage } from '../storage/types';

async function modeStorage(): Promise<E2eeStorage> {
  const fixture = await makeDeviceFixture();
  await registerFixtureDevice(fixture, { opkCount: 0 });
  return fixture.storage;
}

describe('fresh-device chat mode pinning', () => {
  it('pins E2EE immediately without a confirmation step', async () => {
    const storage = await modeStorage();
    const result = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'E2EE' },
      { now: 1000 },
    );
    expect(result.action).toBe('allow_e2ee');
    expect(result.pin?.mode).toBe('E2EE');
    expect(result.pin?.confirmedByUser).toBe(true);
    expect(await readChatModePin(storage, DEVICE_IDS.chat)).toEqual(result.pin);
    const raw = await storage.get<{ v: 1; ciphertext?: string; mode?: string }>(
      'pins',
      `mode:${DEVICE_IDS.chat}`,
    );
    expect(raw?.v).toBe(1);
    expect(typeof raw?.ciphertext).toBe('string');
    expect(raw?.mode).toBeUndefined();
  });

  it('requires explicit confirmation for a clean MANAGED chat and sends no plaintext', async () => {
    const storage = await modeStorage();
    const result = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 1000 },
    );
    expect(result.action).toBe('confirm_mode_required');
    expect(result.pin?.mode).toBe('MANAGED');
    expect(result.pin?.confirmedByUser).toBe(false);
    expect(result.pin?.confirmedAt).toBeNull();
    expect(result.allowedOutcomes).toEqual([]);
  });

  it('allows plaintext only after the user confirms a clean MANAGED chat', async () => {
    const storage = await modeStorage();
    await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 1000 },
    );
    const before = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 1100 },
    );
    expect(before.action).toBe('confirm_mode_required');

    const confirmed = await confirmManagedChatMode(storage, {
      chatId: DEVICE_IDS.chat,
      serverMode: 'MANAGED',
      now: 1200,
    });
    expect(confirmed.confirmedByUser).toBe(true);
    expect(confirmed.confirmedAt).toBe(1200);

    const after = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 1300 },
    );
    expect(after.action).toBe('allow_plaintext');
  });

  it('blocks a MANAGED downgrade when the peer has E2EE devices', async () => {
    const storage = await modeStorage();
    const result = await evaluateChatMode(
      storage,
      {
        chatId: DEVICE_IDS.chat,
        serverMode: 'MANAGED',
        peerHasE2eeCapableDevices: true,
      },
      { now: 1000 },
    );
    expect(result.action).toBe('block_security_alert');
    expect(result.evidence).toContain('peer_has_e2ee_capable_devices');
    expect(result.allowedOutcomes).toEqual(['E2EE_ONLY', 'NEW_MANAGED_CHAT']);
    expect(result.pin).toBeNull();
    expect(await readChatModePin(storage, DEVICE_IDS.chat)).toBeNull();
  });

  it('blocks when a local E2EE pin meets a MANAGED server', async () => {
    const storage = await modeStorage();
    await pinE2eeChatMode(storage, { chatId: DEVICE_IDS.chat, now: 1000 });
    const result = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 2000 },
    );
    expect(result.action).toBe('block_security_alert');
    expect(result.evidence).toContain('local_e2ee_mode_pin');
    expect((await readChatModePin(storage, DEVICE_IDS.chat))?.mode).toBe('E2EE');
  });

  it('treats an E2EE workspace and a local history marker as evidence', async () => {
    const storage = await modeStorage();
    const workspace = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED', workspaceMode: 'E2EE' },
      { now: 1000 },
    );
    expect(workspace.action).toBe('block_security_alert');
    expect(workspace.evidence).toContain('workspace_e2ee');

    const history = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED', e2eeHistoryMarker: true },
      { now: 2000 },
    );
    expect(history.action).toBe('block_security_alert');
    expect(history.evidence).toContain('local_e2ee_history_marker');
  });

  it('forbids in-place MANAGED confirmation when E2EE evidence exists', async () => {
    const storage = await modeStorage();
    await expect(
      confirmManagedChatMode(storage, {
        chatId: DEVICE_IDS.chat,
        serverMode: 'MANAGED',
        evidence: ['peer_has_e2ee_capable_devices'],
      }),
    ).rejects.toMatchObject({ code: 'SECURITY_MODE_MISMATCH' });
    await expect(
      confirmManagedChatMode(storage, {
        chatId: DEVICE_IDS.chat,
        serverMode: 'E2EE',
      }),
    ).rejects.toMatchObject({ code: 'SECURITY_MODE_MISMATCH' });
  });

  it('forbids confirming MANAGED over an existing E2EE pin', async () => {
    const storage = await modeStorage();
    await pinE2eeChatMode(storage, { chatId: DEVICE_IDS.chat, now: 1000 });
    await expect(
      confirmManagedChatMode(storage, {
        chatId: DEVICE_IDS.chat,
        serverMode: 'MANAGED',
        now: 2000,
      }),
    ).rejects.toMatchObject({ code: 'SECURITY_MODE_MISMATCH' });
    expect((await readChatModePin(storage, DEVICE_IDS.chat))?.mode).toBe('E2EE');
  });

  it('upgrades a MANAGED pin to E2EE when the server reports E2EE', async () => {
    const storage = await modeStorage();
    await pinChatMode(storage, {
      chatId: DEVICE_IDS.chat,
      mode: 'MANAGED',
      confirmedByUser: true,
      now: 1000,
    });
    const result = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'E2EE' },
      { now: 2000 },
    );
    expect(result.action).toBe('allow_e2ee');
    expect(result.pin?.mode).toBe('E2EE');
    expect((await readChatModePin(storage, DEVICE_IDS.chat))?.mode).toBe('E2EE');
  });

  it('deletes a mode pin only on an explicit action', async () => {
    const storage = await modeStorage();
    await evaluateChatMode(storage, { chatId: DEVICE_IDS.chat, serverMode: 'E2EE' }, { now: 1000 });
    await deleteChatModePin(storage, DEVICE_IDS.chat);
    expect(await readChatModePin(storage, DEVICE_IDS.chat)).toBeNull();
    const result = await evaluateChatMode(
      storage,
      { chatId: DEVICE_IDS.chat, serverMode: 'MANAGED' },
      { now: 2000 },
    );
    expect(result.action).toBe('confirm_mode_required');
  });
});
