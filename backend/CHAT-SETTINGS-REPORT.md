# Channel settings — cover, rights, privacy, read-only, archive/leave/delete, pins (P0-2 / GitHub #80) — backend report

**Verdict: DONE**

Implementation of channel settings for GROUP channels: cover, read-only flag, visibility and
join policy, a configurable per-role rights matrix, per-user archive, OWNER soft delete and
channel pins. The contract change is additive, V39/V40 are untouched, V41 is new, and no
existing RLS policy or grant was weakened.

## What changed

### 1. Contract (`contracts/openapi.yaml`, additive)

`PATCH /chats/{chatId}` keeps `name`/`description` and adds `cover_file_id`, `read_only`,
`visibility`, `join_policy` and `rights`. New operations:

| Operation | Semantics |
|---|---|
| `POST /chats/{chatId}/cover` | `{file_id}` references an existing managed attachment of the same chat: `image/*`/`media.kind=IMAGE`, READY/BOUND + CLEAN/SKIPPED. OWNER/ADMIN; GROUP only. 404 unknown/foreign/other-chat, 422 `CHAT_COVER_INVALID`, 409 `ATTACHMENT_NOT_READY`, 423 `ATTACHMENT_QUARANTINED`. Idempotent repeat is 200 without a second audit. |
| `DELETE /chats/{chatId}/cover` | OWNER/ADMIN; idempotent 204; the attachment itself is not deleted. |
| `GET /chats/{chatId}/permissions` | Any ACTIVE GROUP participant; complete effective matrix (`post_messages`, `invite_members`, `create_polls`, `start_calls`, `pin_messages`, `change_info` × OWNER/ADMIN/MODERATOR/MEMBER/GUEST). DIRECT → 422. |
| `PATCH /chats/{chatId}/permissions` | OWNER/ADMIN; partial per-role patch; `owner` row is rejected with `422 owner_permissions_fixed`; empty patch/role → 422. Audit contains role/permission names only. |
| `POST /chats/{chatId}/archive` | Any ACTIVE participant (DIRECT included); user-local; idempotent 204; no audit. |
| `POST /chats/{chatId}/unarchive` | Idempotent 204; user-local. |
| `DELETE /chats/{chatId}` | ACTIVE chat OWNER only; soft delete (`deleted_at`), clears `cover_file_id`; repeat → 404; DIRECT → 422. Audit `chat.deleted`. Leave remains `POST /leave`. |
| `GET /chats/{chatId}/pins` | ACTIVE GROUP participant; metadata only (`chat_id`, `message_id`, `pinned_by`, `pinned_at`), newest first; pins of deleted messages are hidden. |
| `POST /chats/{chatId}/pins` | `{message_id}`; `pin_messages` right (OWNER/ADMIN/MODERATOR by default); message must exist in this chat and not be deleted (404); unique → repeat 200 without audit; 50-pin cap → 409 `CHAT_PIN_LIMIT`; E2EE → 422 `E2EE_METADATA_FORBIDDEN`; DIRECT → 422. |
| `DELETE /chats/{chatId}/pins/{messageId}` | `pin_messages`; idempotent 204 (also clears a pin whose message was deleted); audit only on a real removal. |

`GET /workspaces/{workspaceId}/chats` gains `?archived=false|true` (default false = main
list). `Chat` and `ChatSummary` gain additive `cover_file_id`, `read_only`, `join_policy`
(null for DIRECT) and `archived` (caller-local). New schemas: `ChatCoverRequest`,
`ChatRolePermissions`, `ChatPermissions`, `ChatRolePermissionsUpdate`,
`ChatPermissionsUpdate`, `ChatPinRequest`, `ChatPin`, `ChatPinList` (126 → 134 schemas,
71 → 77 paths, 87 → 97 operations). Existing endpoint descriptions for send/poll/member
add/invite were updated to mention the enforced matrix rights.

`frontend/src/api/schema.d.ts` was regenerated with `npm run api:types`.
`frontend/scripts/check-contract.mjs` counts/coverage were moved to 77 paths / 97 operations
/ 134 schemas and P0-2 invariants were added (pins never expose content, owner row is
documented as rejected, cover `file_id` is a required uuid, delete is a bodyless 204,
archive/unarchive document 204). That is the only frontend file outside `schema.d.ts` that
had to change for `npm run contract:check` to stay green.

### 2. Database — V41 (`V41__chat_channel_settings_permissions_archive_pins.sql`)

- `chat.chats`: new `cover_file_id uuid` (FK → `file.attachments(id) ON DELETE SET NULL`) and
  `join_policy text NOT NULL DEFAULT 'INVITE_ONLY'` (`OPEN`/`INVITE_ONLY`/`CLOSED` check).
  `read_only` already existed in V3 (`boolean NOT NULL DEFAULT false`); P0-2 starts enforcing
  it and does not redefine it. Existing GROUP channels are backfilled:
  PUBLIC → `OPEN`, PRIVATE → `INVITE_ONLY`.
- `chat.chat_permissions` — PK `(chat_id, role, permission)`, `allowed boolean`, `updated_at`,
  CHECKs for the five roles and six permissions, `FORCE RLS` following the owning chat,
  SELECT/INSERT/UPDATE/DELETE to `krug_app`. The 30 effective default rows are seeded by the
  application on GROUP creation and backfilled here for existing channels; the application
  also falls back to the built-in defaults when a row is missing.
- `chat.user_chat_archive` — PK `(user_id, chat_id)`, `workspace_id`, `archived_at`; FKs to
  `auth.users`/`chat.chats`/`workspace.workspaces` with CASCADE; self-scoped FORCE RLS
  (`user_id = ops.current_user_id() AND workspace_id = ops.current_workspace_id()`);
  SELECT/INSERT/DELETE to `krug_app`; index `(workspace_id, user_id)`.
- `chat.chat_pins` — PK `(chat_id, message_id)`, `workspace_id`, `pinned_by`, `pinned_at`;
  tenant FORCE RLS; SELECT/INSERT/DELETE; `(chat_id, pinned_at DESC)` index. Metadata only:
  no body/ciphertext column exists (asserted by a test).
- `chat.accept_invite` is replaced (forward-only) to answer `JOIN_CLOSED` for a `CLOSED`
  channel; the existing ACTIVE-member idempotency still wins, so members of a channel that
  became CLOSED keep access. All previous outcomes are unchanged.
- Rollback plan is included in the migration (drop the new tables/columns/FK and restore the
  V40 accept function). Cover/permission/archive/pin data is lost on rollback; chats,
  participants, messages, files and V39 visibility are untouched.

### 3. Application rules

Authorization is layered and explicit:

- `name`/`description`: the D1-BE3 rule is preserved (ACTIVE workspace OWNER/ADMIN, no chat
  membership required). In addition, an ACTIVE GROUP participant whose role has
  `change_info` may edit them, so a channel can delegate info management without workspace
  rights.
- `cover_file_id`, `read_only`, `visibility`, `join_policy`, `rights`: ACTIVE chat
  OWNER/ADMIN only, GROUP only. DIRECT answers `422 CHAT_MEMBERSHIP_UNSUPPORTED`.
- `DELETE /chats/{chatId}`: ACTIVE chat OWNER only (a workspace OWNER/ADMIN who is not a
  participant cannot delete; unknown/foreign is hidden as 404).
- Pins: `pin_messages` for pin/unpin; any ACTIVE participant may list; GROUP only.
- Archive: any ACTIVE participant, including DIRECT; never shared or visible to admins.

Permission enforcement points (`ChatPermissionPort`/`ChatPermissionService`):

| Right | Enforced at |
|---|---|
| `post_messages` | `MessageSubmissionHandler` after a real (non-replay) reservation, before rate limit |
| `invite_members` | `ChatInviteService.create` and `ChatMemberManagementService.add` (OWNER/ADMIN always; another role only with the right; role ceiling still applies) |
| `create_polls` | `PollService.create` |
| `start_calls` | `RealtimeCallAccessAdapter.check` for the initial `OFFER` only (tenant-scoped; answer/ICE/hangup are not re-gated) |
| `pin_messages` | `ChatPinService.pin/unpin` |
| `change_info` | `ChatUpdateService` name/description guard (cover and structural settings remain OWNER/ADMIN) |

Read-only (`403 CHAT_READ_ONLY`) blocks message send and poll creation for every role except
chat OWNER/ADMIN (ABAC-10). The per-role row is still checked afterwards, so an ADMIN with
`post_messages=false` cannot write either. An idempotent replay of a stored `Idempotency-Key`
returns the stored message before the read-only check, so enabling read-only never breaks a
retry.

Coherence and idempotency:

- `visibility=PUBLIC` ⇒ `join_policy=OPEN`. Sending only `visibility=PUBLIC` forces `OPEN`;
  leaving PUBLIC downgrades a workspace-wide `OPEN` to `INVITE_ONLY`. An incoherent
  `PUBLIC + INVITE_ONLY/CLOSED` request is `422 VALIDATION_FAILED` without partial writes.
  Switching PRIVATE → PUBLIC adds every ACTIVE workspace member (idempotent).
- Cover validation reuses the existing attachment pipeline; there is no new upload endpoint.
  The same cover is a no-op; `DELETE /cover` is idempotent; chat soft delete clears
  `cover_file_id` in the same UPDATE ("cover cleanup on delete"), while the attachment row is
  left to the normal file retention/GC flow (the FK clears a dangling reference if the row is
  physically removed).
- Archive and unarchive are idempotent and user-local; the main list excludes archived chats,
  `?archived=true` returns only them. Sync is unchanged (archive is a list/UI concern).
- Pins are unique by `(chat_id, message_id)`, a repeated pin is 200 with no second audit,
  unpin is an idempotent 204, and a pinned message is validated in the message context
  (same workspace/chat, not deleted). The 50-pin cap is `409 CHAT_PIN_LIMIT`.
- E2EE: `description` keeps `422 CHAT_SETTINGS_E2EE_UNSUPPORTED`. Cover and pins are also
  rejected for E2EE (`CHAT_SETTINGS_E2EE_UNSUPPORTED` / `E2EE_METADATA_FORBIDDEN`); because
  an E2EE GROUP cannot be created in this slice these two checks are defense-in-depth, and
  DIRECT chats have no channel settings at all. Name, read-only, visibility, join policy and
  the rights matrix are policy metadata and stay allowed.

Audit (metadata only, no content/values): `chat.updated` (changed field names only),
`chat.permissions.updated` (role and permission names), `chat.cover.updated` (no file id),
`chat.deleted`, `chat.pin.added` / `chat.pin.removed` (message id only). Archive is personal
UI state and writes no audit.

## Tests

New `backend/src/test/java/ru/krug/backend/integration/ChannelSettingsIT.java` (10 tests):

1. Settings patch (name + read_only + visibility + join_policy), DB/audit field-name checks,
   PUBLIC ⇒ OPEN forcing, incoherent PUBLIC+CLOSED 422, MEMBER 403, DIRECT 422, empty patch.
2. Rights matrix defaults for all roles, owner/admin/moderator/member/guest values, partial
   PATCH, audit role/permission names, MEMBER 403, OWNER row 422, empty patch 422,
   DIRECT 422.
3. Read-only blocks a MEMBER send and poll creation, allows the OWNER, idempotent replay
   still works, disabling read-only restores writes, `post_messages`/`create_polls` denials.
4. Cover from a CLEAN image attachment, idempotent repeat, non-image 422, other-chat/unknown
   404, MEMBER 403, idempotent DELETE and audit counts.
5. User-local archive list, another member unaffected, idempotent archive/unarchive,
   non-member 404, DIRECT archivable.
6. Delete is OWNER-only (MEMBER/ADMIN 403, non-participant workspace ADMIN 404), soft delete,
   cover cleared, list/access hidden, repeat 404, single audit, DIRECT 422 and leave 422.
7. Pins: 201 first/200 repeat, single row/audit, metadata-only list (no message text),
   MEMBER denied by default, MODERATOR allowed, grantable `pin_messages`, unknown/other-chat
   message 404, idempotent unpin, deleted message hidden, 50-pin cap 409, DIRECT 422.
8. `invite_members` and `change_info` delegation, role ceiling for a delegated role, right
   revocation takes effect immediately.
9. `join_policy=CLOSED` rejects invite accept (`403 CHAT_JOIN_CLOSED`), `INVITE_ONLY`
   accepts, PRIVATE → PUBLIC adds workspace members and becomes OPEN.
10. Schema/RLS/FK backstops: columns, FORCE RLS/grants for the three new tables, 30 default
    permission rows for GROUP and none for DIRECT, default MEMBER pin=false, pins have no
    content columns, cover FK rejects a dangling id, cross-tenant invisibility of archive/
    permissions/pins.

New `backend/src/test/java/ru/krug/backend/unit/ChannelSettingsDomainTest.java` (4 tests):
default rights matrix, wire-name patch parsing (OWNER/unknown role/permission/null),
visibility/join-policy coherence, literal parsing and semantic errors.

`RealtimeCallSignalingIT` gained one test (11 total): `start_calls` denial blocks the initial
OFFER (recoverable `FORBIDDEN` frame, no relay), restore relays, and answer/ICE are not
re-gated.

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 625, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

Baseline was 610 tests (ArchUnit's 10 rules included); the 15 new tests bring the suite to
625, with ArchUnit still 10/10.

`npm run api:types`; `npm run contract:check` — 97 operations, 134 contract schemas,
77 paths, generated types in sync. `npx tsc -p tsconfig.json --noEmit` — exit 0.

Environment note: the default `mvn` on this machine runs on JDK 26, where pre-existing
Mockito tests fail in Byte Buddy (`Java 26 (70) is not supported`). The suite was run with
JDK 21 (`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home`),
the project baseline; all 625 tests pass there. No test was disabled or skipped.

## Compatibility / rollout

- Additive contract and DB only: existing `Chat`/`ChatSummary` fields and all existing
  operations keep their shapes; new response fields are additive and `user_ids`-style
  projections are untouched.
- `read_only` was already present in V3, so V41 does not change an existing column; it only
  starts enforcing the flag. Existing GROUP channels get `join_policy` and the default
  permission matrix via backfill, so no channel becomes unexpectedly read-only or CLOSED.
- Existing PUBLIC channels are backfilled to `OPEN`, preserving the previous workspace-wide
  auto-join behaviour. `CLOSED` is a new explicit state and does not affect current members.
- The only behavior extensions of existing endpoints are deliberate: `PATCH /chats/{chatId}`
  accepts the new fields, `DELETE /chats/{chatId}` and the cover/permissions/archive/pins
  paths are new, member add/invite honour `invite_members` (OWNER/ADMIN unchanged), and call
  offers check `start_calls` (default true for MEMBER).
- Rollback: drop the three new tables, `chat.chat_pins` indexes, the cover FK and the two new
  columns, and restore the V40 `chat.accept_invite`. Cover/permission/archive/pin data is
  lost; chats, participants, messages, files and V39 visibility are untouched.

## Out of scope

- No new upload pipeline or cover transform/crop: the cover is an existing attachment id.
- No system message for pin/unpin and no `chat.pin.changed` outbox event in this slice; the
  pins API and metadata are complete, realtime fan-out is unchanged.
- No pin rate limit (the 50-pin cap is enforced) and no new `RateLimitPort` windows.
- `read_only` is not applied to `file.upload` (SYSTEM-ANALYSIS ABAC-10 mentions it); message
  send and poll creation are gated, file upload keeps its existing quota/type rules.
- Archive is not reflected in `GET /sync`; it only filters the chat list.
- No frontend UI wiring for the new endpoints (only `schema.d.ts` was regenerated plus the
  contract guard counts).
- E2EE cover/pins guards are defense-in-depth: an E2EE GROUP cannot be created, and DIRECT
  has no channel settings.

## Files

Created:

- `backend/src/main/resources/db/migration/V41__chat_channel_settings_permissions_archive_pins.sql`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatPermission.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChannelJoinPolicy.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChannelSettings.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatPin.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/service/ChatPermissionPolicy.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/service/ChannelSettingsPolicy.java`
- `backend/src/main/java/ru/krug/backend/chat/application/port/ChatPermissionPort.java`
- `backend/src/main/java/ru/krug/backend/chat/application/port/ChatCoverPort.java`
- `backend/src/main/java/ru/krug/backend/chat/application/port/ChatPinMessagePort.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatPermissionsView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatPinView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatPinResult.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatPermissionService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatPermissionsService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatCoverService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatArchiveService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatDeletionService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatPinService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatViewAssembler.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatPinController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatCoverRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatPermissionsUpdateRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatPermissionsResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatRolePermissionsRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatRolePermissionsResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatPinRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatPinResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatPinListResponse.java`
- `backend/src/main/java/ru/krug/backend/file/infrastructure/adapter/ChatCoverAdapter.java`
- `backend/src/main/java/ru/krug/backend/message/infrastructure/adapter/ChatPinMessageAdapter.java`
- `backend/src/test/java/ru/krug/backend/integration/ChannelSettingsIT.java`
- `backend/src/test/java/ru/krug/backend/unit/ChannelSettingsDomainTest.java`

Modified:

- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `frontend/scripts/check-contract.mjs` (contract guard counts/coverage/invariants)
- `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatSummary.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/InviteAcceptance.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatRepository.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/service/ChatMemberPolicy.java`
- `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/ChatRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatSummaryView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatMembershipContext.java`
- `backend/src/main/java/ru/krug/backend/chat/application/command/ChatUpdateCommand.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatUpdateService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatQueryService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatCreateService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatMemberAccessService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatInviteService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatMemberManagementService.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/mapper/ChatApiMapper.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatUpdateRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatSummaryResponse.java`
- `backend/src/main/java/ru/krug/backend/message/application/usecase/MessageSubmissionHandler.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/usecase/PollService.java`
- `backend/src/main/java/ru/krug/backend/realtime/application/usecase/CallSignalingService.java`
- `backend/src/main/java/ru/krug/backend/realtime/application/port/RealtimeCallAccessPort.java`
- `backend/src/main/java/ru/krug/backend/realtime/infrastructure/adapter/RealtimeCallAccessAdapter.java`
- `backend/src/test/java/ru/krug/backend/integration/RealtimeCallSignalingIT.java`
