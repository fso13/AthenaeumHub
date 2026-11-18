/**
 * E7-F8 P1-04: the bridge must run the runtime browser floor before any keyed
 * registration. WebKit passes primitive detection but fails the RFC 8032
 * Ed25519 known-answer probe, so `initialize` has to fail closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eeError } from '../errors';
import type { E2eeDeviceTransport } from './chatBridge';

const { requireE2eeSupportMock } = vi.hoisted(() => ({
  requireE2eeSupportMock: vi.fn(),
}));

vi.mock('../crypto/support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/support')>();
  return { ...actual, requireE2eeSupport: requireE2eeSupportMock };
});

const { createE2eeBridge } = await import('./chatBridge');

function makeTransport(): E2eeDeviceTransport & { registerDevice: ReturnType<typeof vi.fn> } {
  const registerDevice = vi.fn(async () => {
    throw new Error('registerDevice must only run after the browser floor');
  });
  return {
    registerDevice,
    uploadPrekeys: vi.fn(),
    claimPrekeys: vi.fn(),
    getChatKeys: vi.fn(),
    verifyDevice: vi.fn(),
  } as unknown as E2eeDeviceTransport & { registerDevice: ReturnType<typeof vi.fn> };
}

describe('E2EE bridge runtime browser floor', () => {
  beforeEach(() => {
    requireE2eeSupportMock.mockReset();
  });

  it('blocks keyed registration when requireE2eeSupport rejects (WebKit)', async () => {
    requireE2eeSupportMock.mockRejectedValueOnce(
      new E2eeError('E2EE_UNSUPPORTED_BROWSER', 'ed25519 fails RFC 8032'),
    );
    const transport = makeTransport();
    const bridge = createE2eeBridge({
      storage: {} as never,
      transport,
    });

    await expect(
      bridge.initialize({ userId: 'user-1', name: 'WebKit', appVersion: '0.1.0' }),
    ).rejects.toMatchObject({ code: 'E2EE_UNSUPPORTED_BROWSER' });
    expect(requireE2eeSupportMock).toHaveBeenCalledTimes(1);
    expect(transport.registerDevice).not.toHaveBeenCalled();
  });

  it('passes the floor and proceeds to device bootstrap', async () => {
    requireE2eeSupportMock.mockResolvedValueOnce({
      available: true,
      primitives: {},
      missing: [],
    });
    const transport = makeTransport();
    const bridge = createE2eeBridge({ storage: {} as never, transport });

    const failure = await bridge
      .initialize({ userId: 'user-1', name: 'Chromium', appVersion: '0.1.0' })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(requireE2eeSupportMock).toHaveBeenCalledTimes(1);
    // It got past the floor; the fake storage stops the actual registration.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).not.toBe('E2EE_UNSUPPORTED_BROWSER');
  });
});
