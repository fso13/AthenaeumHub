import type {
  ApiMessage,
  ChatInvite,
  ChatMember,
  ChatPermissions,
  ChatPin,
  ChatSummary,
  MeResponse,
  Notification,
  NotificationPreference,
  Session,
  StickerPack,
  StickerRef,
  WorkspaceMember,
  WorkspaceSummary,
} from '../api/types';
import { MOCK_AUTH_EMAIL, MOCK_AUTH_NAME, MOCK_AUTH_SUB } from '../auth/mockProfile';

export const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  device: '22222222-2222-4222-8222-222222222222',
  workspace: '33333333-3333-4333-8333-333333333333',
  groupChat: '44444444-4444-4444-8444-444444444444',
  directChat: '55555555-5555-4555-8555-555555555555',
  anna: '66666666-6666-4666-8666-666666666666',
  mark: '77777777-7777-4777-8777-777777777777',
  lena: '88888888-8888-4888-8888-888888888888',
  olga: '99999999-9999-4999-8999-999999999901',
  pavel: '99999999-9999-4999-8999-999999999902',
  inviteActive: 'a0000000-0000-4000-8000-000000000001',
  inviteExhausted: 'a0000000-0000-4000-8000-000000000002',
  inviteExpired: 'a0000000-0000-4000-8000-000000000003',
  inviteRevoked: 'a0000000-0000-4000-8000-000000000004',
} as const;

/**
 * #79 mock invite tokens. The real token is returned once; the mock keeps the
 * token only to resolve `POST /invites/{token}/accept` in tests.
 */
export const MOCK_INVITE_TOKENS = {
  active: 'mock-invite-active-token-0001',
  exhausted: 'mock-invite-exhausted-token-0002',
  expired: 'mock-invite-expired-token-0003',
  revoked: 'mock-invite-revoked-token-0004',
} as const;

export const MOCK_ACCESS_TOKEN = 'mock-access-token';
export const MOCK_DISPLAY_NAME = MOCK_AUTH_NAME;
export const MOCK_EMAIL = MOCK_AUTH_EMAIL;

/**
 * Auth BFF mock constants (MSW/dev only). `MOCK_EMAIL_CODE` plays the role of a
 * 6-digit email TOTP; the real code is generated and emailed by the backend.
 */
export const MOCK_EMAIL_CODE = '123456';
/**
 * P0-4 (#82) dev-only TOTP code/secret. The real backend derives a per-user
 * secret and never returns it after setup; the mock accepts this fixed code so
 * the setup/login flows are testable without a live authenticator.
 */
export const MOCK_TOTP_CODE = '654321';
export const MOCK_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const MOCK_RECOVERY_CODES = [
  'AAAA-BBBB-CCCC',
  'DDDD-EEEE-FFFF',
  'GGGG-HHHH-IIII',
  'JJJJ-KKKK-LLLL',
  'MMMM-NNNN-OOOO',
  'PPPP-QQQQ-RRRR',
  'SSSS-TTTT-UUUU',
  'VVVV-WWWW-XXXX',
  'YYYY-ZZZZ-2222',
  '3333-4444-5555',
] as const;
export const MOCK_DEMO_EMAIL = 'demo@krug.test';
export const MOCK_DEMO_PASSWORD = 'Pickle-demo-2026';

export const mockSession: Session = {
  access_token: MOCK_ACCESS_TOKEN,
  expires_at: '2026-11-16T15:00:00.000Z',
  user: { id: IDS.user, display_name: MOCK_DISPLAY_NAME },
  device: { id: IDS.device, platform: 'WEB' },
  workspace: { id: IDS.workspace, name: 'Студия «Восход»', security_mode: 'MANAGED' },
  chat: { id: IDS.groupChat, name: 'Команда «Восход»', type: 'GROUP' },
};

export const mockWorkspace: WorkspaceSummary = {
  id: IDS.workspace,
  name: 'Студия «Восход»',
  slug: 'studiya-voshod',
  role: 'OWNER',
  security_mode: 'MANAGED',
};

export function buildMockMe(isPlatformAdmin = true): MeResponse {
  return {
    user: {
      id: MOCK_AUTH_SUB,
      display_name: MOCK_DISPLAY_NAME,
      email: MOCK_EMAIL,
      is_platform_admin: isPlatformAdmin,
    },
    workspaces: [{ ...mockWorkspace }],
    default_workspace_id: IDS.workspace,
  };
}

const SENDERS = [
  { id: IDS.anna, name: 'Анна Петрова' },
  { id: IDS.user, name: MOCK_DISPLAY_NAME },
  { id: IDS.mark, name: 'Марк Соколов' },
  { id: IDS.lena, name: 'Лена Волкова' },
] as const;

/**
 * E10-F active member directory in contract order
 * (`display_name ASC, user_id ASC`). The caller (IDS.user) is included on
 * purpose so the picker's self-exclusion is testable. Only catalog fields —
 * no email/devices/keys.
 */
export function buildWorkspaceMembers(): WorkspaceMember[] {
  return [
    {
      user_id: IDS.anna,
      display_name: 'Анна Петрова',
      role: 'ADMIN',
      joined_at: '2026-01-02T09:00:00.000Z',
    },
    {
      user_id: IDS.user,
      display_name: MOCK_DISPLAY_NAME,
      role: 'OWNER',
      joined_at: '2026-01-01T09:00:00.000Z',
    },
    {
      user_id: IDS.lena,
      display_name: 'Лена Волкова',
      role: 'GUEST',
      joined_at: '2026-01-04T09:00:00.000Z',
    },
    {
      user_id: IDS.mark,
      display_name: 'Марк Соколов',
      role: 'MEMBER',
      joined_at: '2026-01-03T09:00:00.000Z',
    },
  ];
}

/** E12-F mock-only registered-user directory used by add-by-email. */
export interface MockMemberUser {
  user_id: string;
  display_name: string;
  email: string;
}

/**
 * Existing accounts available to `POST /workspaces/{id}/members` in the mock.
 * Current members are included so duplicate/`MEMBER_ALREADY_EXISTS` is
 * testable; `olga`/`pavel` are not members and can be added by email.
 */
export function buildMemberUsers(): MockMemberUser[] {
  return [
    { user_id: IDS.anna, display_name: 'Анна Петрова', email: 'anna@krug.test' },
    { user_id: IDS.user, display_name: MOCK_DISPLAY_NAME, email: MOCK_DEMO_EMAIL },
    { user_id: IDS.lena, display_name: 'Лена Волкова', email: 'lena@krug.test' },
    { user_id: IDS.mark, display_name: 'Марк Соколов', email: 'mark@krug.test' },
    { user_id: IDS.olga, display_name: 'Ольга Смирнова', email: 'olga@krug.test' },
    { user_id: IDS.pavel, display_name: 'Павел Орлов', email: 'pavel@krug.test' },
  ];
}

/**
 * #79 channel participants. The GROUP chat has all four workspace members with
 * distinct roles; DIRECT has the two participants. `status: REMOVED` rows are
 * kept in the mock so add-after-removal can be exercised, while the list
 * endpoint returns ACTIVE rows only (matching the backend read model).
 */
export function buildChatMembers(): Record<string, ChatMember[]> {
  return {
    [IDS.groupChat]: [
      {
        user_id: IDS.anna,
        display_name: 'Анна Петрова',
        role: 'ADMIN',
        status: 'ACTIVE',
        joined_at: '2026-01-02T09:00:00.000Z',
      },
      {
        user_id: IDS.user,
        display_name: MOCK_DISPLAY_NAME,
        role: 'OWNER',
        status: 'ACTIVE',
        joined_at: '2026-01-01T09:00:00.000Z',
      },
      {
        user_id: IDS.lena,
        display_name: 'Лена Волкова',
        role: 'GUEST',
        status: 'ACTIVE',
        joined_at: '2026-01-04T09:00:00.000Z',
      },
      {
        user_id: IDS.mark,
        display_name: 'Марк Соколов',
        role: 'MEMBER',
        status: 'ACTIVE',
        joined_at: '2026-01-03T09:00:00.000Z',
      },
    ],
    [IDS.directChat]: [
      {
        user_id: IDS.anna,
        display_name: 'Анна Петрова',
        role: 'MEMBER',
        status: 'ACTIVE',
        joined_at: '2026-01-02T09:00:00.000Z',
      },
      {
        user_id: IDS.user,
        display_name: MOCK_DISPLAY_NAME,
        role: 'MEMBER',
        status: 'ACTIVE',
        joined_at: '2026-01-01T09:00:00.000Z',
      },
    ],
  };
}

/**
 * #79 seeded invite links: one ACTIVE, one EXHAUSTED, one EXPIRED and one
 * REVOKED. The status is normally computed by the server from `used_count`,
 * `max_uses`, `expires_at` and `revoked_at`; the mock stores the result and
 * updates it on create/revoke/accept.
 */
export function buildChatInvites(): Record<string, ChatInvite[]> {
  return {
    [IDS.groupChat]: [
      {
        id: IDS.inviteActive,
        role: 'MEMBER',
        status: 'ACTIVE',
        used_count: 1,
        max_uses: 5,
        expires_at: '2027-01-01T00:00:00.000Z',
        created_at: '2026-11-10T09:00:00.000Z',
        created_by: IDS.user,
      },
      {
        id: IDS.inviteExhausted,
        role: 'GUEST',
        status: 'EXHAUSTED',
        used_count: 3,
        max_uses: 3,
        expires_at: '2027-01-01T00:00:00.000Z',
        created_at: '2026-11-09T09:00:00.000Z',
        created_by: IDS.user,
      },
      {
        id: IDS.inviteExpired,
        role: 'MEMBER',
        status: 'EXPIRED',
        used_count: 0,
        max_uses: null,
        expires_at: '2026-11-01T00:00:00.000Z',
        created_at: '2026-10-25T09:00:00.000Z',
        created_by: IDS.user,
      },
      {
        id: IDS.inviteRevoked,
        role: 'MODERATOR',
        status: 'REVOKED',
        used_count: 0,
        max_uses: 10,
        expires_at: '2027-01-01T00:00:00.000Z',
        created_at: '2026-11-08T09:00:00.000Z',
        created_by: IDS.user,
      },
    ],
    [IDS.directChat]: [],
  };
}

/**
 * #80 mock rights matrix matching `ChatPermissionPolicy` defaults. OWNER is
 * always all-true; the other roles are editable per chat.
 */
export function buildChatPermissions(): Record<string, ChatPermissions> {
  const all = {
    post_messages: true,
    invite_members: true,
    create_polls: true,
    start_calls: true,
    pin_messages: true,
    change_info: true,
  };
  return {
    [IDS.groupChat]: {
      owner: { ...all },
      admin: { ...all },
      moderator: {
        post_messages: true,
        invite_members: true,
        create_polls: true,
        start_calls: true,
        pin_messages: true,
        change_info: false,
      },
      member: {
        post_messages: true,
        invite_members: false,
        create_polls: true,
        start_calls: true,
        pin_messages: false,
        change_info: false,
      },
      guest: {
        post_messages: true,
        invite_members: false,
        create_polls: false,
        start_calls: false,
        pin_messages: false,
        change_info: false,
      },
    },
  };
}

/** #80 mock pins: metadata only (`chat_id`, `message_id`, `pinned_by`, `pinned_at`). */
export function buildChatPins(): Record<string, ChatPin[]> {
  return {
    [IDS.groupChat]: [
      {
        chat_id: IDS.groupChat,
        message_id: messageId(37),
        pinned_by: IDS.anna,
        pinned_at: iso(16, 9, 0),
      },
    ],
  };
}

const TEXTS = [
  'Привет! Созвон в 11:00 остаётся в силе?',
  'Да, я подготовила короткий апдейт по спринту.',
  'Закинул макеты в папку — посмотрите, пожалуйста.',
  'Спасибо! Выглядит аккуратно.',
  'Тогда фиксируем встречу и идём дальше.',
  'Небольшой вопрос по срокам: успеваем к пятнице?',
  'Думаю, да. Основное уже готово.',
  'Отлично, тогда я обновлю статус в задаче.',
  'Кстати, в релиз войдёт только managed-срез.',
  'Ок, обсудим детали на созвоне.',
] as const;

/** Deterministic UUID-like ids for fixtures. */
export function messageId(seq: number): string {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

/* E5-F: built-in sticker packs. Assets live in `frontend/public/stickers/**`. */
export const STICKER_PACK_IDS = {
  krug: 'a1111111-1111-4111-8111-111111111111',
  cats: 'a2222222-2222-4222-8222-222222222222',
} as const;

export function stickerId(index: number): string {
  return `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const STICKER_ALTS = {
  krug: [
    'Pickle: привет',
    'Pickle: спасибо',
    'Pickle: готово',
    'Pickle: вопрос',
    'Pickle: идея',
    'Pickle: ура',
    'Pickle: обнимаю',
    'Pickle: пока',
  ],
  cats: [
    'Кот: привет',
    'Кот: спит',
    'Кот: еда',
    'Кот: играет',
    'Кот: грустит',
    'Кот: удивлён',
    'Кот: любит',
    'Кот: пока',
  ],
} as const;

export function buildStickerPacks(): StickerPack[] {
  return (Object.keys(STICKER_PACK_IDS) as Array<keyof typeof STICKER_PACK_IDS>).map(
    (key, packIndex) => {
      const stickerOffset = packIndex * 8;
      return {
        id: STICKER_PACK_IDS[key],
        name: key === 'krug' ? 'Pickle' : 'Коты',
        cover_url: `/stickers/${key}/cover.png`,
        stickers: STICKER_ALTS[key].map((alt, index) => ({
          id: stickerId(stickerOffset + index + 1),
          pack_id: STICKER_PACK_IDS[key],
          alt,
          url: `/stickers/${key}/${String(index + 1).padStart(2, '0')}.png`,
          favorite: false,
        })),
      };
    },
  );
}

export function builtinSticker(pack: keyof typeof STICKER_PACK_IDS, index: number): StickerRef {
  const packs = buildStickerPacks();
  const packIndex = pack === 'krug' ? 0 : 1;
  const sticker = packs[packIndex]?.stickers[index];
  if (!sticker) throw new Error(`Unknown built-in sticker: ${pack}/${index}`);
  return sticker;
}

export function iso(day: number, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `2026-11-${pad(day)}T${pad(hour)}:${pad(minute)}:00.000+03:00`;
}

interface DraftMessage {
  seq: number;
  created_at: string;
  sender: { id: string; name: string } | null;
  text: string;
  type?: ApiMessage['type'];
  sticker?: StickerRef;
  reply_to_id?: string | null;
  deleted_at?: string | null;
  /** #61: seeds the visible reaction chips (aggregate by emoji). */
  reactions?: ApiMessage['reactions'];
}

function buildGroupDrafts(): DraftMessage[] {
  const drafts: DraftMessage[] = [];
  let seq = 0;

  const pushDay = (day: number, count: number, startHour: number, startMinute: number) => {
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      const sender = SENDERS[seq % SENDERS.length] ?? SENDERS[0];
      const created = iso(day, startHour, startMinute + (i % 45) * 2);
      drafts.push({
        seq,
        created_at: created,
        sender,
        text: TEXTS[seq % TEXTS.length] ?? '…',
        ...(seq === 8 ? { reply_to_id: messageId(6) } : {}),
        ...(seq === 20 ? { reply_to_id: messageId(18) } : {}),
        ...(seq === 40 ? { reply_to_id: messageId(38) } : {}),
      });
    }
  };

  pushDay(14, 10, 9, 0);
  pushDay(15, 10, 10, 0);
  pushDay(16, 25, 9, 0);

  // Contract allows SYSTEM messages (sender/text nullable).
  const system = drafts.find((draft) => draft.seq === 12);
  if (system) {
    system.type = 'SYSTEM';
    system.sender = null;
    system.text = 'Чат создан';
  }

  // A tombstone from the contract (deleted_at + null text).
  const deleted = drafts.find((draft) => draft.seq === 21);
  if (deleted) {
    deleted.deleted_at = deleted.created_at;
    deleted.text = '';
  }

  // A literal HTML-looking string: the UI must render it as text, not markup.
  const htmlText = drafts.find((draft) => draft.seq === 33);
  if (htmlText) {
    htmlText.text = 'Проверка экранирования: <b>не жирный</b> и <script>alert(1)</script>';
  }

  // E5: a sticker already in history (also proves reload/render parity).
  const stickerMessage = drafts.find((draft) => draft.seq === 34);
  if (stickerMessage) {
    stickerMessage.type = 'STICKER';
    stickerMessage.text = '';
    stickerMessage.sticker = builtinSticker('krug', 2);
    // The history sticker belongs to the viewer so the edit control can show
    // the honest "only text is editable" disabled state.
    stickerMessage.sender = { id: IDS.user, name: MOCK_DISPLAY_NAME };
  }

  // #61: reaction aggregates from the backend (`me` belongs to IDS.user).
  const reacted = drafts.find((draft) => draft.seq === 2);
  if (reacted) {
    reacted.reactions = [
      { emoji: '👍', count: 3, me: true },
      { emoji: '🔥', count: 1, me: false },
    ];
  }
  const peerReacted = drafts.find((draft) => draft.seq === 31);
  if (peerReacted) peerReacted.reactions = [{ emoji: '❤️', count: 2, me: false }];
  const popular = drafts.find((draft) => draft.seq === 37);
  if (popular) popular.reactions = [{ emoji: '🎉', count: 4, me: true }];

  return drafts;
}

function toMessage(chatId: string, draft: DraftMessage): ApiMessage {
  return {
    id: messageId(draft.seq),
    chat_id: chatId,
    seq: draft.seq,
    type: draft.type ?? 'TEXT',
    sender_id: draft.sender?.id ?? null,
    sender_display_name: draft.sender?.name ?? null,
    text: draft.text,
    reply_to_id: draft.reply_to_id ?? null,
    created_at: draft.created_at,
    edited_at: null,
    deleted_at: draft.deleted_at ?? null,
    version: 1,
    reactions: draft.reactions ?? [],
    ...(draft.sticker ? { sticker_id: draft.sticker.id, sticker: { ...draft.sticker } } : {}),
  };
}

export function buildGroupMessages(): ApiMessage[] {
  return buildGroupDrafts().map((draft) => toMessage(IDS.groupChat, draft));
}

export function buildDirectMessages(): ApiMessage[] {
  const drafts: DraftMessage[] = [
    {
      seq: 1,
      created_at: iso(16, 8, 40),
      sender: { id: IDS.anna, name: 'Анна Петрова' },
      text: 'Доброе утро! Скинь, пожалуйста, финальную версию сметы.',
    },
    {
      seq: 2,
      created_at: iso(16, 8, 47),
      sender: { id: IDS.user, name: MOCK_DISPLAY_NAME },
      text: 'Уже собираю, через десять минут будет.',
    },
    {
      seq: 3,
      created_at: iso(16, 8, 49),
      sender: { id: IDS.anna, name: 'Анна Петрова' },
      text: 'Спасибо!',
    },
  ];
  return drafts.map((draft) => toMessage(IDS.directChat, draft));
}

export function buildChatSummaries(): ChatSummary[] {
  return [
    {
      id: IDS.groupChat,
      name: 'Команда «Восход»',
      type: 'GROUP',
      security_mode: 'MANAGED',
      last_message_at: iso(16, 9, 48),
      unread_count: 3,
      last_seq: 45,
    },
    {
      id: IDS.directChat,
      name: 'Анна Петрова',
      type: 'DIRECT',
      security_mode: 'MANAGED',
      peer_id: IDS.anna,
      last_message_at: iso(16, 8, 49),
      unread_count: 0,
      last_seq: 3,
    },
  ];
}

/* ------------------------------------------------------------------------- */
/* E6-F notifications                                                        */
/* ------------------------------------------------------------------------- */

export function notificationId(index: number): string {
  return `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Deterministic seed: two unread notifications, one read system notice and a
 * read managed preview. `body: null` is the E2EE/default-privacy shape: the UI
 * must render the generic title and the "content hidden" explanation instead.
 */
export function buildNotifications(): Notification[] {
  return [
    {
      id: notificationId(1),
      type: 'MESSAGE',
      chat_id: IDS.groupChat,
      chat_name: 'Команда «Восход»',
      title: 'Новое сообщение',
      body: null,
      created_at: iso(16, 9, 52),
      read: false,
    },
    {
      id: notificationId(2),
      type: 'MENTION',
      chat_id: IDS.directChat,
      chat_name: 'Анна Петрова',
      title: 'Новое упоминание',
      body: null,
      created_at: iso(16, 9, 30),
      read: false,
    },
    {
      id: notificationId(3),
      type: 'MESSAGE',
      chat_id: IDS.groupChat,
      chat_name: 'Команда «Восход»',
      title: 'Новое сообщение',
      body: 'Макеты готовы — посмотрите, пожалуйста.',
      created_at: iso(16, 8, 55),
      read: true,
    },
    {
      id: notificationId(4),
      type: 'SYSTEM',
      chat_id: null,
      chat_name: null,
      title: 'Добро пожаловать в Pickle',
      body: null,
      created_at: iso(15, 18, 0),
      read: true,
    },
  ];
}

export function buildNotificationPreferences(): NotificationPreference[] {
  return [
    { chat_id: null, type: 'MESSAGE', channel: 'IN_APP', mode: 'ALL' },
    { chat_id: null, type: 'MENTION', channel: 'IN_APP', mode: 'MENTIONS' },
    { chat_id: IDS.groupChat, type: 'SYSTEM', channel: 'IN_APP', mode: 'MUTE' },
  ];
}
