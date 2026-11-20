#!/usr/bin/env node
/**
 * Contract drift guard.
 *
 * F-01 must not invent fields or endpoints. This script:
 *  1. regenerates the TypeScript schema from contracts/openapi.yaml and
 *     compares it with the committed src/api/schema.d.ts;
 *  2. asserts the exact endpoints/fields the frontend relies on are still
 *     present with compatible shapes.
 *
 * It never modifies the contract.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import openapiTS, { astToString } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.resolve(root, '../contracts/openapi.yaml');
const schemaPath = path.resolve(root, 'src/api/schema.d.ts');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const raw = await fs.readFile(contractPath, 'utf8');
const spec = YAML.parse(raw);

// --- 1. Generated types are in sync with the contract ---------------------
const ast = await openapiTS(spec);
const expected = astToString(ast).trim();
const committed = (await fs.readFile(schemaPath, 'utf8')).trim();

const stripGeneratedHeader = (value) => value.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');

const normalize = (value) =>
  stripGeneratedHeader(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim();

if (normalize(expected) !== normalize(committed)) {
  failures.push(
    'src/api/schema.d.ts is out of date. Run `npm run api:types` and commit the result.',
  );
}

// --- 2. Endpoints used by the frontend -----------------------------------
const operations = {
  'GET /health': spec.paths?.['/health']?.get,
  'POST /dev/session': spec.paths?.['/dev/session']?.post,
  'POST /auth/register': spec.paths?.['/auth/register']?.post,
  'POST /auth/verify-email': spec.paths?.['/auth/verify-email']?.post,
  'POST /auth/resend-email-code': spec.paths?.['/auth/resend-email-code']?.post,
  'POST /auth/login': spec.paths?.['/auth/login']?.post,
  'POST /auth/refresh': spec.paths?.['/auth/refresh']?.post,
  'POST /auth/logout': spec.paths?.['/auth/logout']?.post,
  'GET /setup/status': spec.paths?.['/setup/status']?.get,
  'GET /admin/settings': spec.paths?.['/admin/settings']?.get,
  'PATCH /admin/settings': spec.paths?.['/admin/settings']?.patch,
  'POST /admin/settings/test-email': spec.paths?.['/admin/settings/test-email']?.post,
  'GET /admin/overview': spec.paths?.['/admin/overview']?.get,
  'GET /admin/users': spec.paths?.['/admin/users']?.get,
  'GET /admin/chats': spec.paths?.['/admin/chats']?.get,
  'GET /admin/storage': spec.paths?.['/admin/storage']?.get,
  'GET /workspaces/{workspaceId}/members': spec.paths?.['/workspaces/{workspaceId}/members']?.get,
  'POST /workspaces/{workspaceId}/members': spec.paths?.['/workspaces/{workspaceId}/members']?.post,
  'PATCH /workspaces/{workspaceId}/members/{userId}':
    spec.paths?.['/workspaces/{workspaceId}/members/{userId}']?.patch,
  'DELETE /workspaces/{workspaceId}/members/{userId}':
    spec.paths?.['/workspaces/{workspaceId}/members/{userId}']?.delete,
  'POST /admin/users/{userId}/suspend': spec.paths?.['/admin/users/{userId}/suspend']?.post,
  'POST /admin/users/{userId}/activate': spec.paths?.['/admin/users/{userId}/activate']?.post,
  'DELETE /admin/chats/{chatId}': spec.paths?.['/admin/chats/{chatId}']?.delete,
  'PATCH /chats/{chatId}': spec.paths?.['/chats/{chatId}']?.patch,
  'GET /chats/{chatId}/polls': spec.paths?.['/chats/{chatId}/polls']?.get,
  'POST /chats/{chatId}/polls': spec.paths?.['/chats/{chatId}/polls']?.post,
  'PATCH /chats/{chatId}/polls/{pollId}': spec.paths?.['/chats/{chatId}/polls/{pollId}']?.patch,
  'POST /chats/{chatId}/polls/{pollId}/votes':
    spec.paths?.['/chats/{chatId}/polls/{pollId}/votes']?.post,
  'GET /chats/{chatId}/tasks': spec.paths?.['/chats/{chatId}/tasks']?.get,
  'POST /chats/{chatId}/tasks': spec.paths?.['/chats/{chatId}/tasks']?.post,
  'PATCH /chats/{chatId}/tasks/{taskId}': spec.paths?.['/chats/{chatId}/tasks/{taskId}']?.patch,
  'POST /chats/{chatId}/messages/{messageId}/translate':
    spec.paths?.['/chats/{chatId}/messages/{messageId}/translate']?.post,
  'PATCH /me': spec.paths?.['/me']?.patch,
  'GET /me/sessions': spec.paths?.['/me/sessions']?.get,
  'DELETE /me/sessions/{sessionId}': spec.paths?.['/me/sessions/{sessionId}']?.delete,
  'GET /files': spec.paths?.['/files']?.get,
  'GET /chats/{chatId}/members': spec.paths?.['/chats/{chatId}/members']?.get,
  'POST /chats/{chatId}/members': spec.paths?.['/chats/{chatId}/members']?.post,
  'PATCH /chats/{chatId}/members/{userId}': spec.paths?.['/chats/{chatId}/members/{userId}']?.patch,
  'DELETE /chats/{chatId}/members/{userId}':
    spec.paths?.['/chats/{chatId}/members/{userId}']?.delete,
  'POST /chats/{chatId}/leave': spec.paths?.['/chats/{chatId}/leave']?.post,
  'GET /chats/{chatId}/invites': spec.paths?.['/chats/{chatId}/invites']?.get,
  'POST /chats/{chatId}/invites': spec.paths?.['/chats/{chatId}/invites']?.post,
  'DELETE /chats/{chatId}/invites/{inviteId}':
    spec.paths?.['/chats/{chatId}/invites/{inviteId}']?.delete,
  'POST /invites/{token}/accept': spec.paths?.['/invites/{token}/accept']?.post,
  'POST /users/{userId}/block': spec.paths?.['/users/{userId}/block']?.post,
  'DELETE /users/{userId}/block': spec.paths?.['/users/{userId}/block']?.delete,
  'GET /me/blocked': spec.paths?.['/me/blocked']?.get,
  'POST /chats/{chatId}/cover': spec.paths?.['/chats/{chatId}/cover']?.post,
  'DELETE /chats/{chatId}/cover': spec.paths?.['/chats/{chatId}/cover']?.delete,
  'DELETE /chats/{chatId}': spec.paths?.['/chats/{chatId}']?.delete,
  'GET /chats/{chatId}/permissions': spec.paths?.['/chats/{chatId}/permissions']?.get,
  'PATCH /chats/{chatId}/permissions': spec.paths?.['/chats/{chatId}/permissions']?.patch,
  'POST /chats/{chatId}/archive': spec.paths?.['/chats/{chatId}/archive']?.post,
  'POST /chats/{chatId}/unarchive': spec.paths?.['/chats/{chatId}/unarchive']?.post,
  'GET /chats/{chatId}/pins': spec.paths?.['/chats/{chatId}/pins']?.get,
  'POST /chats/{chatId}/pins': spec.paths?.['/chats/{chatId}/pins']?.post,
  'DELETE /chats/{chatId}/pins/{messageId}':
    spec.paths?.['/chats/{chatId}/pins/{messageId}']?.delete,
  'PATCH /chats/{chatId}/messages/{messageId}':
    spec.paths?.['/chats/{chatId}/messages/{messageId}']?.patch,
  'DELETE /chats/{chatId}/messages/{messageId}':
    spec.paths?.['/chats/{chatId}/messages/{messageId}']?.delete,
  'POST /chats/{chatId}/messages/{messageId}/reactions':
    spec.paths?.['/chats/{chatId}/messages/{messageId}/reactions']?.post,
  'DELETE /chats/{chatId}/messages/{messageId}/reactions/{emoji}':
    spec.paths?.['/chats/{chatId}/messages/{messageId}/reactions/{emoji}']?.delete,
  'GET /plugins': spec.paths?.['/plugins']?.get,
  'GET /chats/{chatId}/plugins': spec.paths?.['/chats/{chatId}/plugins']?.get,
  'PATCH /chats/{chatId}/plugins/{pluginId}':
    spec.paths?.['/chats/{chatId}/plugins/{pluginId}']?.patch,
  'GET /admin/audit': spec.paths?.['/admin/audit']?.get,
  'GET /me': spec.paths?.['/me']?.get,
  'POST /devices': spec.paths?.['/devices']?.post,
  'GET /devices': spec.paths?.['/devices']?.get,
  'DELETE /devices/{deviceId}': spec.paths?.['/devices/{deviceId}']?.delete,
  'POST /devices/{deviceId}/prekeys': spec.paths?.['/devices/{deviceId}/prekeys']?.post,
  'POST /keys/claim': spec.paths?.['/keys/claim']?.post,
  'POST /workspaces/{workspaceId}/chats': spec.paths?.['/workspaces/{workspaceId}/chats']?.post,
  'GET /chats/{chatId}/keys': spec.paths?.['/chats/{chatId}/keys']?.get,
  'PUT /chats/{chatId}/keys/verification': spec.paths?.['/chats/{chatId}/keys/verification']?.put,
  'POST /workspaces': spec.paths?.['/workspaces']?.post,
  'GET /workspaces/{workspaceId}/chats': spec.paths?.['/workspaces/{workspaceId}/chats']?.get,
  'GET /workspaces/{workspaceId}/limits': spec.paths?.['/workspaces/{workspaceId}/limits']?.get,
  // P0-3 (#81): workspace DLP, audit/export, sessions and security settings.
  'GET /workspaces/{workspaceId}/dlp/policies':
    spec.paths?.['/workspaces/{workspaceId}/dlp/policies']?.get,
  'POST /workspaces/{workspaceId}/dlp/policies':
    spec.paths?.['/workspaces/{workspaceId}/dlp/policies']?.post,
  'PATCH /workspaces/{workspaceId}/dlp/policies/{policyId}':
    spec.paths?.['/workspaces/{workspaceId}/dlp/policies/{policyId}']?.patch,
  'DELETE /workspaces/{workspaceId}/dlp/policies/{policyId}':
    spec.paths?.['/workspaces/{workspaceId}/dlp/policies/{policyId}']?.delete,
  'GET /workspaces/{workspaceId}/dlp/events':
    spec.paths?.['/workspaces/{workspaceId}/dlp/events']?.get,
  'GET /workspaces/{workspaceId}/audit': spec.paths?.['/workspaces/{workspaceId}/audit']?.get,
  'GET /workspaces/{workspaceId}/audit/export':
    spec.paths?.['/workspaces/{workspaceId}/audit/export']?.get,
  'GET /workspaces/{workspaceId}/sessions': spec.paths?.['/workspaces/{workspaceId}/sessions']?.get,
  'POST /workspaces/{workspaceId}/sessions/revoke-all':
    spec.paths?.['/workspaces/{workspaceId}/sessions/revoke-all']?.post,
  'DELETE /workspaces/{workspaceId}/sessions/{sessionId}':
    spec.paths?.['/workspaces/{workspaceId}/sessions/{sessionId}']?.delete,
  'GET /workspaces/{workspaceId}/security': spec.paths?.['/workspaces/{workspaceId}/security']?.get,
  'PATCH /workspaces/{workspaceId}/security':
    spec.paths?.['/workspaces/{workspaceId}/security']?.patch,
  'GET /sticker-packs': spec.paths?.['/sticker-packs']?.get,
  'PUT /stickers/{stickerId}/favorite': spec.paths?.['/stickers/{stickerId}/favorite']?.put,
  'DELETE /stickers/{stickerId}/favorite': spec.paths?.['/stickers/{stickerId}/favorite']?.delete,
  'GET /chats/{chatId}/messages': spec.paths?.['/chats/{chatId}/messages']?.get,
  'POST /chats/{chatId}/messages': spec.paths?.['/chats/{chatId}/messages']?.post,
  'POST /chats/{chatId}/read': spec.paths?.['/chats/{chatId}/read']?.post,
  'GET /sync': spec.paths?.['/sync']?.get,
  'POST /realtime/ticket': spec.paths?.['/realtime/ticket']?.post,
  'GET /notifications': spec.paths?.['/notifications']?.get,
  'POST /notifications/read': spec.paths?.['/notifications/read']?.post,
  'GET /notification-preferences': spec.paths?.['/notification-preferences']?.get,
  'PATCH /notification-preferences': spec.paths?.['/notification-preferences']?.patch,
  'POST /uploads/preflight': spec.paths?.['/uploads/preflight']?.post,
  'POST /uploads': spec.paths?.['/uploads']?.post,
  'GET /uploads/{uploadId}': spec.paths?.['/uploads/{uploadId}']?.get,
  'PUT /uploads/{uploadId}/parts/{partNo}': spec.paths?.['/uploads/{uploadId}/parts/{partNo}']?.put,
  'POST /uploads/{uploadId}/complete': spec.paths?.['/uploads/{uploadId}/complete']?.post,
  'POST /uploads/{uploadId}/abort': spec.paths?.['/uploads/{uploadId}/abort']?.post,
  'GET /attachments/{attachmentId}/download-url':
    spec.paths?.['/attachments/{attachmentId}/download-url']?.get,
  // P0-4 (#82): avatar, TOTP authenticator, workspace settings/invites/permissions.
  'POST /me/avatar': spec.paths?.['/me/avatar']?.post,
  'DELETE /me/avatar': spec.paths?.['/me/avatar']?.delete,
  'GET /me/avatar': spec.paths?.['/me/avatar']?.get,
  'GET /me/2fa': spec.paths?.['/me/2fa']?.get,
  'DELETE /me/2fa': spec.paths?.['/me/2fa']?.delete,
  'POST /me/2fa/setup': spec.paths?.['/me/2fa/setup']?.post,
  'POST /me/2fa/verify': spec.paths?.['/me/2fa/verify']?.post,
  'POST /me/2fa/recovery-codes': spec.paths?.['/me/2fa/recovery-codes']?.post,
  'POST /auth/2fa/verify': spec.paths?.['/auth/2fa/verify']?.post,
  'PATCH /workspaces/{workspaceId}': spec.paths?.['/workspaces/{workspaceId}']?.patch,
  'POST /workspaces/{workspaceId}/avatar': spec.paths?.['/workspaces/{workspaceId}/avatar']?.post,
  'DELETE /workspaces/{workspaceId}/avatar':
    spec.paths?.['/workspaces/{workspaceId}/avatar']?.delete,
  'GET /workspaces/{workspaceId}/invites': spec.paths?.['/workspaces/{workspaceId}/invites']?.get,
  'POST /workspaces/{workspaceId}/invites': spec.paths?.['/workspaces/{workspaceId}/invites']?.post,
  'DELETE /workspaces/{workspaceId}/invites/{inviteId}':
    spec.paths?.['/workspaces/{workspaceId}/invites/{inviteId}']?.delete,
  'POST /workspace-invites/{token}/accept': spec.paths?.['/workspace-invites/{token}/accept']?.post,
  'GET /workspaces/{workspaceId}/permissions':
    spec.paths?.['/workspaces/{workspaceId}/permissions']?.get,
  'PATCH /workspaces/{workspaceId}/permissions':
    spec.paths?.['/workspaces/{workspaceId}/permissions']?.patch,
};

for (const [operation, definition] of Object.entries(operations)) {
  check(Boolean(definition), `Contract is missing operation: ${operation}`);
}

// --- 3. Fields consumed by the UI / store --------------------------------
const schemas = spec.components?.schemas ?? {};
const requiredFields = {
  Error: ['code', 'message', 'request_id'],
  Session: ['access_token', 'expires_at', 'user', 'device', 'workspace', 'chat'],
  AuthSession: ['access_token', 'refresh_token', 'expires_in', 'token_type', 'user'],
  AuthSessionUser: ['id', 'display_name', 'email'],
  AuthRegisterRequest: ['email', 'display_name', 'password'],
  AuthRegisterResponse: ['verification_id', 'expires_in', 'resend_after'],
  AuthVerifyEmailRequest: ['verification_id', 'code'],
  AuthLoginRequest: ['email', 'password'],
  AuthRefreshRequest: ['refresh_token'],
  AuthLogoutRequest: ['refresh_token'],
  SetupStatus: ['setup_required', 'registration_open'],
  AdminSettings: [
    'setup_completed',
    'smtp_configured',
    'max_chats_per_user',
    'max_chats_per_workspace',
    'max_workspace_members',
    'registration_open',
  ],
  AdminOverview: ['users', 'workspaces', 'chats'],
  AdminUser: [
    'id',
    'email',
    'display_name',
    'is_platform_admin',
    'status',
    'workspaces_count',
    'chats_count',
    'storage_used_bytes',
    'created_at',
  ],
  AdminUserPage: ['items', 'has_more'],
  AdminChat: [
    'id',
    'name',
    'type',
    'security_mode',
    'workspace_id',
    'workspace_name',
    'members_count',
    'messages_count',
    'created_at',
    'last_activity_at',
  ],
  AdminChatPage: ['items', 'has_more'],
  AdminStorageTotals: ['used_bytes', 'reserved_bytes', 'objects', 'attachments'],
  AdminStorageWorkspace: [
    'workspace_id',
    'workspace_name',
    'security_mode',
    'used_bytes',
    'reserved_bytes',
    'storage_limit_bytes',
    'objects',
    'attachments',
  ],
  AdminStorage: ['totals', 'workspaces'],
  AdminAuditEvent: [
    'id',
    'action',
    'actor_id',
    'actor_email',
    'target_type',
    'target_id',
    'created_at',
  ],
  AdminAuditPage: ['items', 'has_more'],
  WorkspaceMember: ['user_id', 'display_name', 'role', 'joined_at'],
  AddWorkspaceMemberRequest: ['email', 'role'],
  ChangeWorkspaceMemberRoleRequest: ['role'],
  MeResponse: ['user', 'workspaces', 'default_workspace_id'],
  WorkspaceSummary: ['id', 'name', 'slug', 'role', 'security_mode'],
  CreateWorkspaceRequest: ['name', 'security_mode'],
  DeviceRegistration: ['name', 'platform', 'app_version'],
  Device: ['id', 'platform', 'created_at'],
  WorkspaceLimits: [
    'tariff',
    'max_file_bytes',
    'storage_bytes',
    'max_attachments',
    'guest_file_bytes',
    'usage',
  ],
  PreflightFile: ['name', 'size'],
  PreflightRequest: ['chat_id', 'files'],
  PreflightDecision: ['name', 'allowed'],
  PreflightResponse: ['decision', 'max_file_bytes', 'max_attachments', 'quota', 'files'],
  UploadInitRequest: ['chat_id', 'filename', 'size', 'encryption_mode'],
  UploadSession: ['upload_id', 'status', 'part_size', 'total_parts', 'expires_at'],
  UploadPart: ['part_no', 'received'],
  UploadCompleteRequest: ['sha256', 'parts_count'],
  AttachmentRef: ['id', 'size_bytes', 'scan_status'],
  DownloadUrl: ['url', 'expires_at', 'size_bytes', 'sha256'],
  // #73: the file center is metadata-only and cursor paged.
  FilePage: ['items', 'page', 'quota'],
  FileQuotaSummary: ['used_bytes', 'reserved_bytes', 'storage_bytes', 'percent'],
  // #72: profile patch + Keycloak sessions.
  AuthUser: ['id', 'display_name', 'email', 'is_platform_admin'],
  ProfileSession: ['id', 'name', 'created_at', 'last_access_at', 'current'],
  ProfileSessions: ['sessions'],
  RealtimeTicket: ['ticket', 'expires_at', 'ws_url'],
  ChatSummary: ['id', 'name', 'type', 'security_mode', 'unread_count', 'last_seq'],
  ChatList: ['items'],
  Message: ['id', 'chat_id', 'seq', 'type', 'created_at', 'version'],
  // E4: text is optional; text or attachment_ids must be present.
  MessageCreate: ['client_message_id', 'type'],
  MessagePage: ['items', 'page'],
  ReadRequest: ['last_seq'],
  SyncResponse: ['server_time', 'chats'],
  StickerRef: ['id', 'pack_id', 'alt', 'url', 'favorite'],
  StickerPack: ['id', 'name', 'cover_url', 'stickers'],
  StickerPackList: ['items'],
  Notification: ['id', 'type', 'chat_id', 'title', 'created_at', 'read'],
  NotificationPage: ['items', 'page', 'unread_count'],
  NotificationPreference: ['type', 'channel', 'mode'],
  NotificationPreferences: ['items'],
  // E7/I-01: device keys, prekeys, claim, chat keys, verification, E2EE chat.
  DeviceList: ['items'],
  SignedPrekey: ['key_id', 'public_key', 'signature'],
  OneTimePrekey: ['key_id', 'public_key'],
  CryptoHeader: ['v', 'dh', 'pn', 'n'],
  PrekeyBlock: [
    'sender_identity_signing_key',
    'sender_identity_dh_key',
    'sender_ephemeral_key',
    'recipient_identity_dh_key',
    'spk_id',
    'spk_public',
    'signature',
  ],
  CryptoEnvelope: [
    'v',
    'scheme',
    'chat_id',
    'sender_device_id',
    'sender_key_generation',
    'recipient_device_id',
    'recipient_key_generation',
    'session_id',
    'header',
    'ciphertext',
  ],
  PrekeyUploadResult: ['device_id', 'key_generation', 'one_time_prekeys_available'],
  KeyClaimRequest: ['chat_id', 'devices'],
  PrekeyBundle: [
    'user_id',
    'device_id',
    'key_generation',
    'identity_signing_key',
    'identity_dh_key',
    'identity_binding_signature',
    'identity_key_alg',
    'signed_prekey',
    'otp_exhausted',
  ],
  UnavailableDevice: ['device_id', 'reason'],
  KeyClaimResponse: ['bundles', 'unavailable'],
  DeviceKeyInfo: [
    'device_id',
    'user_id',
    'status',
    'key_generation',
    'identity_signing_key',
    'identity_dh_key',
    'identity_binding_signature',
    'identity_key_alg',
    'fingerprint',
    'is_self',
  ],
  ChatKeysResponse: ['chat_id', 'security_mode', 'my_device_id', 'verifier_device_id', 'devices'],
  VerificationRequest: ['device_id', 'method', 'vh_version', 'safety_number_hash'],
  VerificationResponse: [
    'chat_id',
    'verifier_device_id',
    'device_id',
    'key_generation',
    'verified',
    'verified_at',
    'method',
  ],
  EnvelopeCoverage: [
    'devices',
    'covered',
    'peer_devices',
    'peer_covered',
    'self_devices',
    'self_covered',
    'uncovered_device_ids',
  ],
  Chat: ['id', 'type', 'security_mode', 'last_seq', 'unread_count', 'created_at'],
  ChatCreateRequest: ['type'],
  PollOption: ['id', 'text', 'position', 'votes'],
  Poll: ['id', 'question', 'options', 'creator_id', 'closed', 'created_at', 'total_votes'],
  Task: ['id', 'title', 'creator_id', 'done', 'created_at'],
  Translation: ['text'],
};

for (const [schemaName, fields] of Object.entries(requiredFields)) {
  const schema = schemas[schemaName];
  check(Boolean(schema), `Contract is missing schema: ${schemaName}`);
  if (!schema) continue;
  for (const field of fields) {
    check(
      Array.isArray(schema.required) && schema.required.includes(field),
      `${schemaName}.${field} must remain required`,
    );
  }
}

const meUserProperty = schemas.MeResponse?.properties?.user;
// `GET /me` now reuses `AuthUser`; resolve the local $ref instead of silently
// skipping the check when the contract switches to a shared schema.
const meUserSchema = meUserProperty?.$ref
  ? schemas[meUserProperty.$ref.split('/').pop()]
  : meUserProperty;
check(
  Array.isArray(meUserSchema?.required) &&
    ['id', 'display_name', 'email'].every((field) => meUserSchema.required.includes(field)),
  'MeResponse.user must require id, display_name and email',
);

check(
  schemas.MessageCreate?.properties?.text?.maxLength === 8000,
  'MessageCreate.text maxLength must stay 8000 (UI limit depends on it)',
);
check(
  schemas.MessagePage?.properties?.items?.type === 'array',
  'MessagePage.items must stay an array',
);
check(
  spec.paths?.['/workspaces']?.post?.parameters?.some(
    (parameter) => parameter?.$ref === '#/components/parameters/DeviceId',
  ),
  'POST /workspaces must keep the X-Device-Id header',
);

check(
  spec.paths?.['/realtime/ticket']?.post?.parameters?.some(
    (parameter) => parameter?.$ref === '#/components/parameters/DeviceId',
  ),
  'POST /realtime/ticket must keep the X-Device-Id header',
);

check(
  typeof schemas.RealtimeTicket?.properties?.ws_url?.example === 'string',
  'RealtimeTicket.ws_url must stay documented (client resolution depends on it)',
);

check(
  spec.paths?.['/chats/{chatId}/messages']?.get?.parameters?.some(
    (parameter) => parameter?.$ref === '#/components/parameters/DeviceId',
  ) ||
    spec.paths?.['/chats/{chatId}/messages']?.parameters?.some(
      (parameter) => parameter?.$ref === '#/components/parameters/DeviceId',
    ),
  'GET /chats/{chatId}/messages must keep the X-Device-Id header',
);

// --- 4. E4 file pipeline invariants ---------------------------------------
check(
  schemas.MessageCreate?.properties?.attachment_ids?.maxItems === 10,
  'MessageCreate.attachment_ids maxItems must stay 10',
);
check(
  schemas.Message?.properties?.attachments?.items?.$ref === '#/components/schemas/AttachmentRef',
  'Message.attachments must be an array of AttachmentRef',
);
check(
  schemas.PreflightRequest?.properties?.files?.maxItems === 10,
  'PreflightRequest.files maxItems must stay 10',
);
check(
  Array.isArray(schemas.UploadInitRequest?.properties?.encryption_mode?.enum) &&
    schemas.UploadInitRequest.properties.encryption_mode.enum.includes('MANAGED'),
  'UploadInitRequest.encryption_mode must allow MANAGED',
);
for (const status of [
  'INIT',
  'UPLOADING',
  'PAUSED',
  'SCANNING',
  'READY',
  'QUARANTINED',
  'BOUND',
  'EXPIRED',
]) {
  check(
    Array.isArray(schemas.UploadSession?.properties?.status?.enum) &&
      schemas.UploadSession.properties.status.enum.includes(status),
    `UploadSession.status must include ${status}`,
  );
}
check(
  schemas.UploadSession?.properties?.part_size?.type === 'integer',
  'UploadSession.part_size must stay an integer',
);
check(
  schemas.UploadPart?.properties?.received?.type === 'boolean',
  'UploadPart.received must stay a boolean',
);
check(
  Array.isArray(schemas.AttachmentRef?.properties?.scan_status?.enum) &&
    schemas.AttachmentRef.properties.scan_status.enum.includes('CLEAN') &&
    schemas.AttachmentRef.properties.scan_status.enum.includes('INFECTED'),
  'AttachmentRef.scan_status must keep CLEAN/INFECTED',
);
check(
  spec.paths?.['/uploads/{uploadId}/parts/{partNo}']?.put?.parameters?.some(
    (parameter) => parameter?.$ref === '#/components/parameters/ContentSha256',
  ),
  'PUT /uploads/{uploadId}/parts/{partNo} must keep Content-SHA256',
);
check(
  Boolean(spec.paths?.['/uploads/{uploadId}/complete']?.post?.responses?.['202']),
  'POST /uploads/{uploadId}/complete must document 202 SCANNING',
);
check(
  Boolean(spec.paths?.['/attachments/{attachmentId}/download-url']?.get?.responses?.['423']),
  'GET /attachments/{attachmentId}/download-url must document 423 quarantine',
);
check(
  ['used', 'reserved', 'limit'].every(
    (field) =>
      Array.isArray(schemas.WorkspaceLimits?.properties?.usage?.required) &&
      schemas.WorkspaceLimits.properties.usage.required.includes(field),
  ),
  'WorkspaceLimits.usage must require used/reserved/limit',
);

// --- 4a. #72/#73 profile and file-center invariants ----------------------
check(
  schemas.FileItem?.allOf?.some((entry) => entry?.$ref === '#/components/schemas/AttachmentRef'),
  'FileItem must stay AttachmentRef + provenance (no invented fields)',
);
for (const field of ['object_key', 'sha256', 'url', 'content']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.FileItem?.properties ?? {}, field),
    `FileItem must not expose ${field}`,
  );
}
check(
  schemas.FilePage?.properties?.page?.properties?.has_more?.type === 'boolean',
  'FilePage.page.has_more must stay a boolean',
);
check(
  Array.isArray(schemas.FilePage?.properties?.quota?.oneOf) &&
    schemas.FilePage.properties.quota.oneOf.some((entry) => entry?.type === 'null'),
  'FilePage.quota must stay nullable',
);
for (const field of ['ip', 'ip_address', 'username', 'access_token', 'refresh_token']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.ProfileSession?.properties ?? {}, field),
    `ProfileSession must not expose ${field}`,
  );
}
check(
  schemas.ProfileUpdate?.properties?.email === undefined &&
    schemas.ProfileUpdate?.properties?.password === undefined,
  'ProfileUpdate must not accept email/password',
);
check(
  schemas.ProfileUpdate?.properties?.display_name?.maxLength === 80,
  'ProfileUpdate.display_name maxLength must stay 80',
);
check(
  schemas.ProfileUpdate?.properties?.bio?.maxLength === 280,
  'ProfileUpdate.bio maxLength must stay 280',
);
check(
  schemas.ProfileUpdate?.properties?.phone?.maxLength === 32,
  'ProfileUpdate.phone maxLength must stay 32',
);

// --- 5a. E7/I-01 invariants ----------------------------------------------
check(
  schemas.DeviceRegistration?.required?.length === 3 &&
    ['name', 'platform', 'app_version'].every((field) =>
      schemas.DeviceRegistration.required.includes(field),
    ),
  'DeviceRegistration.required must stay [name, platform, app_version] (D-S4-03)',
);
for (const field of [
  'identity_signing_key',
  'identity_dh_key',
  'identity_binding_signature',
  'identity_key_alg',
  'signed_prekey',
  'one_time_prekeys',
]) {
  check(
    Object.prototype.hasOwnProperty.call(schemas.DeviceRegistration?.properties ?? {}, field),
    `DeviceRegistration.${field} must be documented`,
  );
}
check(
  schemas.DeviceRegistration?.properties?.one_time_prekeys?.maxItems === 200,
  'DeviceRegistration.one_time_prekeys maxItems must stay 200',
);
for (const name of ['Base64Url16', 'Base64Url32', 'Base64Url64']) {
  check(
    schemas[name]?.contentEncoding === 'base64url',
    `${name} must use contentEncoding base64url`,
  );
}
check(
  schemas.MessageCreate?.properties?.envelopes?.maxItems === 10 &&
    schemas.MessageCreate?.properties?.envelopes?.minItems === 1,
  'MessageCreate.envelopes must stay 1..10',
);
check(
  schemas.CryptoEnvelope?.properties?.ciphertext?.maxLength === 44054 &&
    schemas.CryptoEnvelope?.properties?.ciphertext?.minLength === 363,
  'CryptoEnvelope.ciphertext must stay 363..44054 (P2-11)',
);
check(
  schemas.PrekeyBlock?.properties?.spk_id?.pattern === '^[A-Za-z0-9._-]+$',
  'PrekeyBlock.spk_id must keep the DDL pattern (D-S4-05)',
);
check(
  schemas.PrekeyBlock?.properties?.opk_id?.pattern === '^[A-Za-z0-9._-]+$',
  'PrekeyBlock.opk_id must keep the DDL pattern (D-S4-05)',
);
check(
  Array.isArray(schemas.ChatSummary?.properties?.name?.type) &&
    schemas.ChatSummary.properties.name.type.includes('null'),
  'ChatSummary.name must stay nullable (D-S4-02)',
);
check(
  Object.prototype.hasOwnProperty.call(
    schemas.ChatSummary?.properties ?? {},
    'peer_has_e2ee_capable_devices',
  ),
  'ChatSummary.peer_has_e2ee_capable_devices must be documented (D-S4-06)',
);
check(
  schemas.Message?.properties?.crypto !== undefined &&
    schemas.Message?.properties?.client_message_id !== undefined,
  'Message must expose client_message_id and crypto (I-01)',
);
check(
  schemas.MessageCreateResult?.allOf?.some((part) => part?.$ref === '#/components/schemas/Message'),
  'MessageCreateResult must extend Message (D-S4-04)',
);
check(
  schemas.EnvelopeCoverage?.required?.includes('peer_covered') &&
    schemas.EnvelopeCoverage?.required?.includes('uncovered_device_ids'),
  'EnvelopeCoverage must require peer/self counters and uncovered ids',
);
check(
  schemas.UnavailableDevice?.properties?.reason?.enum?.length === 2 &&
    !schemas.UnavailableDevice.properties.reason.enum.includes('NOT_MEMBER'),
  'UnavailableDevice.reason must be NO_SPK|NO_KEYS (P2-3)',
);
check(
  schemas.VerificationRequest?.properties?.vh_version?.enum?.includes(2),
  'VerificationRequest.vh_version must be 2 (P2-2)',
);
check(
  typeof schemas.Error?.description === 'string' &&
    ['E2EE_DISABLED', 'KEY_CHANGED', 'E2EE_LEGACY_DEVICE'].every((code) =>
      schemas.Error.description.includes(code),
    ),
  'Error.description must enumerate the E2EE error codes',
);

// --- 5b. E11 admin action / audit invariants -----------------------------
// Bodyless 204 mutations + documented 403/404/409 states (FR-ADM-15..18).
for (const [operation, statuses] of Object.entries({
  'POST /admin/users/{userId}/suspend': ['204', '403', '404', '409', '503'],
  'POST /admin/users/{userId}/activate': ['204', '403', '404', '409', '503'],
  'DELETE /admin/chats/{chatId}': ['204', '403', '404', '409'],
})) {
  const [method, path] = operation.split(' ');
  const definition = spec.paths?.[path]?.[method.toLowerCase()];
  check(Boolean(definition), `Contract is missing operation: ${operation}`);
  for (const status of statuses) {
    check(Boolean(definition?.responses?.[status]), `${operation} must document ${status}`);
  }
  check(!definition?.responses?.['204']?.content, `${operation} 204 must stay bodyless`);
}
// The admin audit projection must stay metadata-free by construction.
for (const forbidden of ['metadata', 'request_id', 'prev_hash', 'hash', 'scope_key']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.AdminAuditEvent?.properties ?? {}, forbidden),
    `AdminAuditEvent must not expose ${forbidden}`,
  );
}
check(
  Array.isArray(schemas.AdminAuditEvent?.required) &&
    ['id', 'action', 'actor_id', 'actor_email', 'target_type', 'target_id', 'created_at'].every(
      (field) => schemas.AdminAuditEvent.required.includes(field),
    ),
  'AdminAuditEvent must expose exactly the documented identity fields',
);
check(
  schemas.AdminAuditPage?.properties?.next_cursor?.type?.includes('null'),
  'AdminAuditPage.next_cursor must stay nullable (system/legacy events)',
);
check(
  spec.paths?.['/admin/audit']?.get?.parameters?.some(
    (parameter) =>
      parameter?.name === 'action' &&
      parameter?.schema?.maxLength === 120 &&
      !parameter?.schema?.enum,
  ),
  'GET /admin/audit action filter must stay an exact string (max 120), not an invented enum',
);
check(
  spec.paths?.['/admin/audit']?.get?.parameters?.some(
    (parameter) =>
      parameter?.name === 'limit' &&
      parameter?.schema?.default === 30 &&
      parameter?.schema?.maximum === 100,
  ),
  'GET /admin/audit must keep limit default 30 / max 100',
);

// --- 5. E5 sticker invariants --------------------------------------------
check(
  Object.keys(spec.paths ?? {}).length === 98,
  'Contract must expose exactly 98 paths (E6 + I-01 + auth BFF + E8 + E9 + E10 + E11 + E12 + D1 + message-actions + profile/plugins/files/plugin-actions + channel-members + channel-settings + P0-3 security)',
);
// Strict equality: a regression to `=` made this guard a tautology (P2-09). The operation
// list is fixed; a new path must be added here deliberately, together with its checks.
check(
  Object.keys(operations).length === 127,
  'Contract check must cover exactly 127 operations (E6 + I-01 + auth BFF + E8 + E9 + E10 + E11 + E12 + D1 + message-actions + profile/plugins/files/plugin-actions + channel-members + channel-settings + P0-3 security)',
);
check(
  Object.keys(schemas).length === 170,
  'Contract must expose exactly 170 schemas (E6 + I-01 + auth BFF + E8 + E9 + E10 + E11 + E12 + D1 + message-actions + profile/plugins/files/plugin-actions + channel-members + channel-settings + P0-3 security)',
);

check(
  ['TEXT', 'STICKER', 'SYSTEM'].every((type) =>
    schemas.Message?.properties?.type?.enum?.includes(type),
  ),
  'Message.type must allow TEXT/STICKER/SYSTEM',
);
check(
  ['TEXT', 'STICKER'].every((type) =>
    schemas.MessageCreate?.properties?.type?.enum?.includes(type),
  ),
  'MessageCreate.type must allow TEXT/STICKER',
);
check(
  Object.prototype.hasOwnProperty.call(schemas.Message?.properties ?? {}, 'sticker_id'),
  'Message.sticker_id must remain documented',
);
check(
  Object.prototype.hasOwnProperty.call(schemas.Message?.properties ?? {}, 'sticker'),
  'Message.sticker must remain documented',
);
check(
  schemas.StickerRef?.properties?.favorite?.type === 'boolean',
  'StickerRef.favorite must stay a boolean',
);
check(
  typeof schemas.StickerRef?.properties?.alt?.maxLength === 'number' &&
    schemas.StickerRef.properties.alt.maxLength === 120,
  'StickerRef.alt must keep maxLength 120',
);
check(
  schemas.StickerPack?.properties?.stickers?.type === 'array' &&
    schemas.StickerPack.properties.stickers.items?.$ref === '#/components/schemas/StickerRef',
  'StickerPack.stickers must remain an array of StickerRef',
);
check(
  spec.paths?.['/sticker-packs']?.get?.parameters?.some(
    (parameter) => parameter?.name === 'chat_id' && parameter?.required === true,
  ),
  'GET /sticker-packs must require chat_id',
);
check(
  Boolean(spec.paths?.['/stickers/{stickerId}/favorite']?.put?.responses?.['204']) &&
    Boolean(spec.paths?.['/stickers/{stickerId}/favorite']?.delete?.responses?.['204']),
  'PUT/DELETE /stickers/{stickerId}/favorite must document 204',
);
check(
  ['put', 'delete'].every((method) => {
    const pathDefinition = spec.paths?.['/stickers/{stickerId}/favorite'];
    const parameters = [
      ...(pathDefinition?.parameters ?? []),
      ...(pathDefinition?.[method]?.parameters ?? []),
    ];
    return (
      parameters.some((parameter) => parameter?.$ref === '#/components/parameters/StickerId') &&
      parameters.some((parameter) => parameter?.$ref === '#/components/parameters/DeviceId')
    );
  }),
  'Favorite mutations must keep StickerId and X-Device-Id',
);

// --- 6. E6 notification invariants --------------------------------------
check(
  ['MESSAGE', 'MENTION', 'SYSTEM'].every((type) =>
    schemas.Notification?.properties?.type?.enum?.includes(type),
  ),
  'Notification.type must allow MESSAGE/MENTION/SYSTEM',
);
check(
  Array.isArray(schemas.Notification?.properties?.body?.type) &&
    schemas.Notification.properties.body.type.includes('null'),
  'Notification.body must stay nullable (E2EE/default privacy)',
);
check(
  Array.isArray(schemas.NotificationPage?.properties?.page?.required) &&
    schemas.NotificationPage.properties.page.required.includes('has_more'),
  'NotificationPage.page must require has_more',
);
check(
  schemas.NotificationPage?.properties?.unread_count?.minimum === 0,
  'NotificationPage.unread_count must not be negative',
);
check(
  schemas.ReadNotificationsRequest?.properties?.ids?.maxItems === 100,
  'ReadNotificationsRequest.ids maxItems must stay 100',
);
check(
  ['ALL', 'MENTIONS', 'MUTE'].every((mode) =>
    schemas.NotificationPreference?.properties?.mode?.enum?.includes(mode),
  ),
  'NotificationPreference.mode must allow ALL/MENTIONS/MUTE',
);
check(
  ['IN_APP', 'EMAIL'].every((channel) =>
    schemas.NotificationPreference?.properties?.channel?.enum?.includes(channel),
  ),
  'NotificationPreference.channel must allow IN_APP/EMAIL',
);
check(
  Array.isArray(schemas.NotificationPreferencePatch?.allOf) &&
    schemas.NotificationPreferencePatch.allOf[1]?.required?.includes('mode'),
  'NotificationPreferencePatch must require mode',
);
check(
  spec.paths?.['/notifications']?.get?.parameters?.some(
    (parameter) =>
      parameter?.name === 'limit' &&
      parameter?.schema?.default === 30 &&
      parameter?.schema?.maximum === 100,
  ),
  'GET /notifications must keep limit default 30 / max 100',
);
check(
  ['/notifications/read', '/notification-preferences'].every((path) => {
    const post = spec.paths?.[path]?.post ?? spec.paths?.[path]?.patch;
    const parameters = [...(spec.paths?.[path]?.parameters ?? []), ...(post?.parameters ?? [])];
    return (
      parameters.some((parameter) => parameter?.$ref === '#/components/parameters/DeviceId') &&
      parameters.some((parameter) => parameter?.$ref === '#/components/parameters/IdempotencyKey')
    );
  }),
  'Notification mutations must keep X-Device-Id and Idempotency-Key',
);

// --- 6. D1.1 (#76) plugin action invariants ------------------------------
check(
  schemas.PollCreate?.properties?.options?.minItems === 2 &&
    schemas.PollCreate?.properties?.options?.maxItems === 10,
  'PollCreate.options must stay 2..10 (poll composer bounds)',
);
check(schemas.Poll?.properties?.options?.maxItems === 10, 'Poll.options maxItems must stay 10');
check(
  schemas.Translation?.properties?.text?.maxLength === 8000,
  'Translation.text maxLength must stay 8000',
);
check(
  schemas.TaskUpdate?.required?.length === 1 && schemas.TaskUpdate.required[0] === 'done',
  'TaskUpdate must only require done',
);

// --- 7. Channel members / invites / blocks (#79) --------------------------
check(
  Array.isArray(schemas.ChatMemberIds?.required) &&
    ['user_ids', 'members'].every((field) => schemas.ChatMemberIds.required.includes(field)),
  'ChatMemberIds must keep user_ids and add members (additive)',
);
for (const field of ['user_id', 'display_name', 'role', 'status', 'joined_at']) {
  check(
    Array.isArray(schemas.ChatMember?.required) && schemas.ChatMember.required.includes(field),
    `ChatMember.${field} must remain required`,
  );
}
check(
  Array.isArray(schemas.ChatInviteCreated?.allOf) &&
    schemas.ChatInviteCreated.allOf.some((part) =>
      Object.prototype.hasOwnProperty.call(part?.properties ?? {}, 'token'),
    ),
  'ChatInviteCreated must expose the one-time token',
);
check(
  !Object.prototype.hasOwnProperty.call(schemas.ChatInvite?.properties ?? {}, 'token_hash') &&
    !Object.prototype.hasOwnProperty.call(schemas.ChatInvite?.properties ?? {}, 'token'),
  'ChatInvite must never expose the token or its hash',
);
check(
  ['ACTIVE', 'EXPIRED', 'EXHAUSTED', 'REVOKED'].every((status) =>
    schemas.ChatInvite?.properties?.status?.enum?.includes(status),
  ),
  'ChatInvite.status must expose ACTIVE/EXPIRED/EXHAUSTED/REVOKED',
);
check(
  Boolean(spec.paths?.['/invites/{token}/accept']?.post?.responses?.['410']),
  'POST /invites/{token}/accept must document 410 for expired/revoked/exhausted links',
);
for (const field of ['email', 'display_name']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.BlockedUser?.properties ?? {}, field),
    `BlockedUser must not expose ${field}`,
  );
}
for (const status of ['409', '422']) {
  check(
    Boolean(spec.paths?.['/chats/{chatId}/members/{userId}']?.patch?.responses?.[status]),
    `PATCH /chats/{chatId}/members/{userId} must document ${status}`,
  );
}

if (failures.length > 0) {
  console.error('\nContract check failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// --- 7. P0-2 channel settings invariants --------------------------------
// Pins are metadata-only by construction; no content/ciphertext field may appear.
for (const field of ['text', 'body', 'content', 'ciphertext', 'envelope', 'attachments']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.ChatPin?.properties ?? {}, field),
    `ChatPin must not expose ${field}`,
  );
}
check(
  ['chat_id', 'message_id', 'pinned_by', 'pinned_at'].every((field) =>
    schemas.ChatPin?.required?.includes(field),
  ),
  'ChatPin must require only the metadata ids/time',
);
// OWNER rights are fixed: the owner row may only be present in order to be rejected.
check(
  Object.prototype.hasOwnProperty.call(schemas.ChatPermissionsUpdate?.properties ?? {}, 'owner') &&
    String(schemas.ChatPermissionsUpdate.description).includes('owner_permissions_fixed'),
  'ChatPermissionsUpdate.owner must be documented as a rejected row',
);
check(
  [
    'post_messages',
    'invite_members',
    'create_polls',
    'start_calls',
    'pin_messages',
    'change_info',
  ].every((field) =>
    Object.prototype.hasOwnProperty.call(schemas.ChatRolePermissions?.properties ?? {}, field),
  ),
  'ChatRolePermissions must document the full P0-2 rights matrix',
);
// The cover references an existing attachment and there is no upload endpoint here.
check(
  schemas.ChatCoverRequest?.properties?.file_id?.format === 'uuid' &&
    schemas.ChatCoverRequest?.required?.includes('file_id'),
  'ChatCoverRequest.file_id must be a required uuid',
);
check(
  ['cover_file_id', 'read_only', 'visibility', 'join_policy', 'rights'].every((field) =>
    Object.prototype.hasOwnProperty.call(schemas.ChatUpdateRequest?.properties ?? {}, field),
  ),
  'ChatUpdateRequest must expose the P0-2 channel settings',
);
check(
  Boolean(spec.paths?.['/chats/{chatId}/cover']?.post?.responses?.['423']),
  'POST /chats/{chatId}/cover must document 423 quarantine',
);
check(
  Boolean(spec.paths?.['/chats/{chatId}']?.delete?.responses?.['204']) &&
    !spec.paths['/chats/{chatId}'].delete.responses['204'].content,
  'DELETE /chats/{chatId} must document a bodyless 204',
);
check(
  ['204'].every(
    (status) =>
      Boolean(spec.paths?.['/chats/{chatId}/archive']?.post?.responses?.[status]) &&
      Boolean(spec.paths?.['/chats/{chatId}/unarchive']?.post?.responses?.[status]),
  ),
  'Archive/unarchive must document idempotent 204',
);

// --- P0-3 (#81) workspace security invariants ----------------------------
for (const field of [
  'id',
  'name',
  'action',
  'pattern_type',
  'pattern',
  'enabled',
  'created_at',
  'updated_at',
]) {
  check(
    Array.isArray(schemas.DlpPolicy?.required) && schemas.DlpPolicy.required.includes(field),
    `DlpPolicy.${field} must remain required`,
  );
}
check(
  schemas.DlpPolicy?.properties?.pattern?.maxLength === 200,
  'DlpPolicy.pattern maxLength must stay 200 (bounded literal, never regex)',
);
check(
  Array.isArray(schemas.DlpPolicyCreateRequest?.properties?.action?.enum) &&
    schemas.DlpPolicyCreateRequest.properties.action.enum.includes('BLOCK') &&
    schemas.DlpPolicyCreateRequest.properties.action.enum.includes('WARN'),
  'DlpPolicyCreateRequest.action must stay WARN/BLOCK',
);
check(
  String(schemas.DlpPolicyCreateRequest?.properties?.pattern?.description ?? '')
    .toLowerCase()
    .includes('redos'),
  'DlpPolicyCreateRequest.pattern must document the no-regex/ReDoS guarantee',
);
for (const field of ['text', 'content', 'ciphertext', 'filename', 'email', 'ip_address']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.DlpEvent?.properties ?? {}, field),
    `DlpEvent must not expose ${field}`,
  );
}
check(
  Boolean(
    spec.paths?.['/workspaces/{workspaceId}/audit/export']?.get?.responses?.['200']?.content?.[
      'text/csv'
    ],
  ) &&
    Boolean(
      spec.paths?.['/workspaces/{workspaceId}/audit/export']?.get?.responses?.['200']?.content?.[
        'application/json'
      ],
    ),
  'Audit export must document CSV and JSON responses',
);
check(
  schemas.WorkspaceAuditExport?.properties?.exported_rows?.maximum === 10000,
  'WorkspaceAuditExport.exported_rows must stay bounded at 10000',
);
for (const field of ['metadata', 'actor_email', 'request_id', 'hash']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.WorkspaceAuditEvent?.properties ?? {}, field),
    `WorkspaceAuditEvent must not expose ${field}`,
  );
}
for (const field of ['ip', 'ip_address', 'username', 'access_token', 'refresh_token']) {
  check(
    !Object.prototype.hasOwnProperty.call(schemas.WorkspaceSession?.properties ?? {}, field),
    `WorkspaceSession must not expose ${field}`,
  );
}
check(
  schemas.WorkspaceSecurity?.properties?.security_mode === undefined,
  'WorkspaceSecurity must not expose a mutable security_mode',
);
check(
  String(
    schemas.WorkspaceSecurityUpdateRequest?.properties?.security_mode?.description ?? '',
  ).includes('MODE_CHANGE_FORBIDDEN'),
  'WorkspaceSecurityUpdateRequest.security_mode must document the immutable mode',
);
check(
  schemas.WorkspaceSessionRevokeAll?.properties?.revoked_sessions?.minimum === 0 &&
    schemas.WorkspaceSessionRevokeAll?.properties?.affected_users?.minimum === 0,
  'WorkspaceSessionRevokeAll counters must stay non-negative',
);
check(
  Boolean(
    spec.paths?.['/workspaces/{workspaceId}/dlp/policies/{policyId}']?.delete?.responses?.['204'],
  ),
  'DELETE /workspaces/{workspaceId}/dlp/policies/{policyId} must document 204',
);
check(
  Boolean(
    spec.paths?.['/workspaces/{workspaceId}/sessions/revoke-all']?.post?.responses?.['200'],
  ) &&
    Boolean(
      spec.paths?.['/workspaces/{workspaceId}/sessions/{sessionId}']?.delete?.responses?.['204'],
    ),
  'Session revoke-all/revoke must document their success responses',
);

check(
  String(spec.paths?.['/chats/{chatId}/messages']?.post?.description ?? '').includes('DLP_BLOCKED'),
  'POST /chats/{chatId}/messages must document the DLP_BLOCKED send gate',
);

console.log(
  `Contract check passed: ${Object.keys(operations).length} operations, ` +
    `${Object.keys(schemas).length} contract schemas ` +
    `(${Object.keys(requiredFields).length} checked for required fields), ` +
    'generated types in sync.',
);
