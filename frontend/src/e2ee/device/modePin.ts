/**
 * Fresh-device security-mode pinning (§6.2.8, §7.6, D-22/P1-G-1).
 *
 * A local 'chat_id → mode' pin survives reload and is the only client-side
 * memory of "this chat was E2EE". On a fresh device:
 * - server 'E2EE' → pin 'E2EE', encrypted path only;
 * - server 'MANAGED' with any E2EE evidence (workspace/history/peer capable
 *   devices/an existing E2EE pin) → security alert, send blocked, and only
 *   'E2EE_ONLY' or a **new** managed chat are legal outcomes;
 * - server 'MANAGED' with no evidence → explicit mode confirmation is required
 *   before any plaintext may be sent.
 *
 * In-place downgrade of a chat with E2EE evidence is never confirmable. F3
 * implements the policy and storage; F5/F6 render it.
 */
import { E2eeError } from '../errors';
import { isUuid } from '../encoding/bytes';
import type { E2eeStorage } from '../storage/types';
import { deleteSealedModePin, mutateSealedModePin, readSealedModePin } from './pinStore';
import type {
  ChatModeEvaluation,
  ChatModeEvaluationInput,
  ChatModeEvidence,
  ChatModePinRecord,
  ChatSecurityMode,
} from './types';

const ALLOWED_OUTCOMES = ['E2EE_ONLY', 'NEW_MANAGED_CHAT'] as const;

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireMode(value: string): ChatSecurityMode {
  if (value !== 'E2EE' && value !== 'MANAGED') {
    throw new E2eeError('SECURITY_MODE_MISMATCH', 'unknown chat security mode');
  }
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid timestamp`);
  }
  return value;
}

function validateModePin(value: unknown): ChatModePinRecord {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'chat mode pin is not an object');
  }
  const pin = value as Partial<ChatModePinRecord>;
  if (pin.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'chat mode pin version is unsupported');
  }
  const chatId = requireUuid(pin.chatId ?? '', 'mode_pin.chat_id');
  const mode = requireMode(pin.mode ?? '');
  if (
    pin.source !== 'server' &&
    pin.source !== 'workspace' &&
    pin.source !== 'user' &&
    pin.source !== 'history'
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'chat mode pin source is invalid');
  }
  if (typeof pin.confirmedByUser !== 'boolean') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'chat mode pin confirmation flag is invalid');
  }
  if (pin.confirmedAt !== null) requireTimestamp(pin.confirmedAt ?? -1, 'mode_pin.confirmed_at');
  return {
    v: 1,
    chatId,
    mode,
    pinnedAt: requireTimestamp(pin.pinnedAt ?? -1, 'mode_pin.pinned_at'),
    source: pin.source,
    confirmedByUser: pin.confirmedByUser,
    confirmedAt: pin.confirmedAt ?? null,
  };
}

export async function readChatModePin(
  storage: E2eeStorage,
  chatId: string,
): Promise<ChatModePinRecord | null> {
  const value = await readSealedModePin(storage, chatId);
  return value === null ? null : validateModePin(value);
}

export interface PinChatModeOptions {
  readonly chatId: string;
  readonly mode: ChatSecurityMode;
  readonly source?: ChatModePinRecord['source'];
  readonly confirmedByUser?: boolean;
  readonly now?: number;
}

export async function pinChatMode(
  storage: E2eeStorage,
  options: PinChatModeOptions,
): Promise<ChatModePinRecord> {
  const now = options.now ?? Date.now();
  const chatId = requireUuid(options.chatId, 'chat_id');
  const mode = requireMode(options.mode);
  return mutateSealedModePin<ChatModePinRecord>(storage, chatId, (current) => {
    const existing = current === null ? null : validateModePin(current);
    if (existing !== null && existing.mode === mode) {
      return { pin: undefined, result: existing };
    }
    if (existing?.mode === 'E2EE' && mode === 'MANAGED') {
      throw new E2eeError(
        'SECURITY_MODE_MISMATCH',
        'in-place MANAGED downgrade of an E2EE chat is forbidden',
      );
    }
    const confirmedByUser = options.confirmedByUser ?? mode === 'E2EE';
    const pin: ChatModePinRecord = {
      v: 1,
      chatId,
      mode,
      pinnedAt: now,
      source: options.source ?? 'server',
      confirmedByUser,
      confirmedAt: confirmedByUser ? now : null,
    };
    return { pin, result: pin };
  });
}

function evidenceFor(
  input: ChatModeEvaluationInput,
  pin: ChatModePinRecord | null,
): ChatModeEvidence[] {
  const evidence: ChatModeEvidence[] = [];
  if (pin?.mode === 'E2EE') evidence.push('local_e2ee_mode_pin');
  if (input.workspaceMode === 'E2EE') evidence.push('workspace_e2ee');
  if (input.peerHasE2eeCapableDevices === true) evidence.push('peer_has_e2ee_capable_devices');
  if (input.e2eeHistoryMarker === true) evidence.push('local_e2ee_history_marker');
  return evidence;
}

/**
 * Evaluates the server-reported mode against the local pin and E2EE evidence.
 * Never sends plaintext: 'allow_plaintext' is returned only for a pinned,
 * explicitly confirmed MANAGED chat without E2EE evidence.
 */
export async function evaluateChatMode(
  storage: E2eeStorage,
  input: ChatModeEvaluationInput,
  options: { readonly now?: number } = {},
): Promise<ChatModeEvaluation> {
  const now = options.now ?? Date.now();
  const chatId = requireUuid(input.chatId, 'chat_id');
  const serverMode = requireMode(input.serverMode);

  return mutateSealedModePin<ChatModeEvaluation>(storage, chatId, (current) => {
    const existing = current === null ? null : validateModePin(current);

    if (serverMode === 'E2EE') {
      if (existing?.mode === 'E2EE') {
        return {
          pin: undefined,
          result: {
            action: 'allow_e2ee',
            chatId,
            pin: existing,
            evidence: evidenceFor(input, existing),
            allowedOutcomes: [],
          },
        };
      }
      const pin: ChatModePinRecord = {
        v: 1,
        chatId,
        mode: 'E2EE',
        pinnedAt: now,
        source: input.workspaceMode === 'E2EE' ? 'workspace' : 'server',
        confirmedByUser: true,
        confirmedAt: now,
      };
      return {
        pin,
        result: {
          action: 'allow_e2ee',
          chatId,
          pin,
          evidence: evidenceFor(input, pin),
          allowedOutcomes: [],
        },
      };
    }

    const evidence = evidenceFor(input, existing);
    if (evidence.length > 0) {
      return {
        pin: undefined,
        result: {
          action: 'block_security_alert',
          chatId,
          pin: existing,
          evidence,
          allowedOutcomes: ALLOWED_OUTCOMES,
        },
      };
    }
    if (existing === null) {
      const pin: ChatModePinRecord = {
        v: 1,
        chatId,
        mode: 'MANAGED',
        pinnedAt: now,
        source: 'server',
        confirmedByUser: false,
        confirmedAt: null,
      };
      return {
        pin,
        result: {
          action: 'confirm_mode_required',
          chatId,
          pin,
          evidence: [],
          allowedOutcomes: [],
        },
      };
    }
    if (existing.confirmedByUser) {
      return {
        pin: undefined,
        result: {
          action: 'allow_plaintext',
          chatId,
          pin: existing,
          evidence: [],
          allowedOutcomes: [],
        },
      };
    }
    return {
      pin: undefined,
      result: {
        action: 'confirm_mode_required',
        chatId,
        pin: existing,
        evidence: [],
        allowedOutcomes: [],
      },
    };
  });
}

export interface ConfirmManagedModeOptions {
  readonly chatId: string;
  readonly serverMode: ChatSecurityMode;
  readonly evidence?: readonly ChatModeEvidence[];
  readonly now?: number;
}

/**
 * Explicit user confirmation for a genuinely managed chat. It is deliberately
 * impossible when E2EE evidence exists: that would be an in-place downgrade
 * (§6.2.8 п. 3(б), P1-G-1).
 */
export async function confirmManagedChatMode(
  storage: E2eeStorage,
  options: ConfirmManagedModeOptions,
): Promise<ChatModePinRecord> {
  const chatId = requireUuid(options.chatId, 'chat_id');
  if (requireMode(options.serverMode) !== 'MANAGED') {
    throw new E2eeError('SECURITY_MODE_MISMATCH', 'server mode is not MANAGED');
  }
  if ((options.evidence ?? []).length > 0) {
    throw new E2eeError(
      'SECURITY_MODE_MISMATCH',
      'in-place MANAGED downgrade is forbidden when E2EE evidence exists',
    );
  }
  const now = options.now ?? Date.now();
  return mutateSealedModePin<ChatModePinRecord>(storage, chatId, (current) => {
    const existing = current === null ? null : validateModePin(current);
    if (existing?.mode === 'E2EE') {
      throw new E2eeError(
        'SECURITY_MODE_MISMATCH',
        'in-place MANAGED downgrade of an E2EE chat is forbidden',
      );
    }
    const pin: ChatModePinRecord = {
      v: 1,
      chatId,
      mode: 'MANAGED',
      pinnedAt: existing?.pinnedAt ?? now,
      source: 'user',
      confirmedByUser: true,
      confirmedAt: now,
    };
    return { pin, result: pin };
  });
}

/** Pins E2EE for a chat confirmed by the server (or a newly created E2EE chat). */
export async function pinE2eeChatMode(
  storage: E2eeStorage,
  options: {
    readonly chatId: string;
    readonly source?: ChatModePinRecord['source'];
    readonly now?: number;
  },
): Promise<ChatModePinRecord> {
  return pinChatMode(storage, {
    chatId: options.chatId,
    mode: 'E2EE',
    source: options.source ?? 'server',
    confirmedByUser: true,
    now: options.now,
  });
}

export async function deleteChatModePin(storage: E2eeStorage, chatId: string): Promise<void> {
  await deleteSealedModePin(storage, chatId);
}
