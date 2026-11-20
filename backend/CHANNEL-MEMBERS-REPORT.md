# Channel members and invite links (P0-1 / GitHub #79) — backend report

**Verdict: DONE**

Implementation of channel participant management (list with display details, add, role
change, remove, leave), GROUP-channel invite links (hash-only storage, expiry/max-uses,
revoke, accept) and self-service user blocks. The contract change is additive, V39 is
untouched, V40 is new, and no existing RLS policy or grant was weakened.

## What changed

### 1. Contract (`contracts/openapi.yaml`, additive)

The existing `GET /chats/{chatId}/members` response schema `ChatMemberIds` is extended:
`user_ids` is kept unchanged, and `members[]` is added with
`{user_id, display_name, role, status, joined_at}`. New operations:

| Operation | Semantics |
|---|---|
| `POST /chats/{chatId}/members` | `{user_id, role?}`; OWNER/ADMIN; target must be an ACTIVE workspace member; PUBLIC/PRIVATE GROUP; idempotent (201 first write, 200 repeat with the unchanged role); DIRECT → 422 |
| `PATCH /chats/{chatId}/members/{userId}` | `{role}`; OWNER/ADMIN; self change → 409; ADMIN ceiling → 403; last OWNER → 409; no-op repeat is 200 without audit; DIRECT → 422 |
| `DELETE /chats/{chatId}/members/{userId}` | OWNER/ADMIN or self (leave); soft `status = 'REMOVED'`; last OWNER → 409; self removal is idempotent; DIRECT → 422 |
| `POST /chats/{chatId}/leave` | idempotent self-leave alias (204, repeat 204); last OWNER → 409; DIRECT → 422 |
| `GET /chats/{chatId}/invites` | OWNER/ADMIN; metadata only (`id`, `role`, `status`, `used_count`, `max_uses`, `expires_at`, `created_at`, `created_by`); `status` ∈ ACTIVE/EXPIRED/EXHAUSTED/REVOKED |
| `POST /chats/{chatId}/invites` | OWNER/ADMIN; `{role?, max_uses?, expires_in_seconds?}`; defaults MEMBER / unlimited / 7 days (300…2592000 s, 1…1000 uses); raw `token` returned exactly once; OWNER is not assignable through a link; rate-limited per chat |
| `DELETE /chats/{chatId}/invites/{inviteId}` | OWNER/ADMIN; soft revoke (`revoked_at`); idempotent 204 |
| `POST /invites/{token}/accept` | ACTIVE workspace member; joins with the invite role; idempotent for an existing ACTIVE member (`already_member=true`, no use consumed); 410 with `INVITE_EXPIRED`/`INVITE_REVOKED`/`INVITE_EXHAUSTED`; rate-limited per user |
| `POST /users/{userId}/block` | idempotent 204; self → 400; unknown/inactive user → 404 |
| `DELETE /users/{userId}/block` | idempotent 204 |
| `GET /me/blocked` | own list only, `{user_id, blocked_at}` — no email/display name |

New schemas: `ChatMember`, `AddChatMemberRequest`, `ChangeChatMemberRoleRequest`,
`ChatInvite`, `ChatInviteCreated`, `ChatInviteCreateRequest`, `ChatInviteList`,
`InviteAcceptResult`, `BlockedUser`, `BlockedUserList`. New path parameters `UserId`,
`InviteId`, `InviteToken`; new tag `users`.

`frontend/src/api/schema.d.ts` was regenerated with `npm run api:types`
(openapi-typescript 7.13.0). Because `frontend/scripts/check-contract.mjs` pins the exact
path/operation/schema counts and the operation list, its counts were moved
64 → 71 paths, 76 → 87 operations, 116 → 126 schemas, the new operations were added to the
coverage list, and contract invariants for the new schemas were added (token never exposed
by `ChatInvite`, one-time token on create, 410 documented for accept, no email/display name
on `BlockedUser`). That is the only frontend file outside `schema.d.ts` that had to change
for `npm run contract:check` to stay green.

### 2. Database — V40 (`V40__chat_members_invites_and_blocks.sql`)

- `chat.invites`: `id` PK, `workspace_id`, `chat_id`, `token_hash` (SHA-256 hex, unique,
  `CHECK ~ '^[a-f0-9]{64}$'`), `role` (`ADMIN/MODERATOR/MEMBER/GUEST` — OWNER is not
  assignable by link), `created_by`, nullable `max_uses` (1…1000), `used_count`,
  `expires_at NOT NULL`, `revoked_at`, `created_at`; `CHECK used_count <= max_uses`.
  Indexes `ix_invites_chat_created`, `ix_invites_ws_expiry`; `ENABLE` + `FORCE ROW LEVEL
  SECURITY` with the tenant policy `workspace_id = ops.current_workspace_id()`; grants
  SELECT/INSERT/UPDATE/DELETE to `krug_app`. The raw token has no column at all.
- `chat.ix_chat_members_chat_role` partial index `(chat_id, role) WHERE status = 'ACTIVE'`
  for owner counts / member directory.
- `auth.user_blocks`: `(blocker_id, blocked_id)` PK, `created_at`, self-block `CHECK`;
  identity-scoped self-only RLS (`blocker_id = ops.current_user_id()`), index
  `ix_user_blocks_blocker_created`, grants SELECT/INSERT/DELETE to `krug_app` (no UPDATE).
- `chat.member_directory(chat_id, user_id)` — read-only SECURITY DEFINER lookup returning
  `user_id, display_name, role, status, joined_at` for ACTIVE participants, only when the
  caller is an ACTIVE member of the chat's ACTIVE workspace (`ops.current_user_id()`), stable
  order `display_name ASC, user_id ASC`, EXECUTE to `krug_app` only. Needed because
  `auth.users` is FORCE RLS with a self-only policy (same pattern as V24).
- `chat.accept_invite(token_hash, user_id)` — SECURITY DEFINER plpgsql: validates the caller
  GUC, `SELECT … FOR UPDATE` on the invite row (so `max_uses` is exact under concurrency),
  checks ACTIVE workspace membership and a live GROUP chat, answers an existing ACTIVE member
  before expiry/revocation (idempotency) without incrementing `used_count`, then upserts the
  participant with the invite role and increments `used_count`. Outcome strings:
  `OK/NOT_FOUND/FORBIDDEN/CHAT_UNAVAILABLE/REVOKED/EXPIRED/EXHAUSTED`.
- `auth.set_user_block(blocker, blocked, blocked)` — SECURITY DEFINER idempotent
  block/unblock with target-existence check, returns
  `OK/UNCHANGED/SELF/USER_NOT_FOUND/FORBIDDEN` (`UNCHANGED` suppresses a duplicate audit
  event).
- Forward-only rollback plan is included in the migration. No existing table/column/policy is
  altered.

### 3. Application

**Chat member management** (`ChatMemberManagementService`,
`ChatMemberAccessService`, `ChatMemberPolicy`):

- Workspace resolution from the chat via the existing V30 `chat.settings_scope` (the URL has
  no workspace), then the tenant GUC is bound; unknown/deleted/foreign chats are `404`.
- Caller must be an ACTIVE participant with role OWNER/ADMIN for management; the target must
  be an ACTIVE workspace member (checked in the app **and** guarded by the
  `INSERT … SELECT FROM workspace.memberships WHERE status = 'ACTIVE'` statement, so a
  concurrent workspace removal cannot create a foreign participant).
- ADMIN cannot manage OWNER/ADMIN rows and cannot assign OWNER/ADMIN
  (`403 ROLE_CHANGE_FORBIDDEN`); OWNER may assign any role, including a second OWNER.
- Last ACTIVE OWNER protection: add/role/remove/leave take the same per-chat advisory lock
  (`chat.members|<chatId>`) before counting owners, so two concurrent demotions/leaves cannot
  both pass. Self role-change is `409 SELF_ACTION_FORBIDDEN`.
- `POST` never changes an existing ACTIVE member's role (idempotent 200); `PATCH` is the only
  role-change path. A REMOVED row is re-activated with the requested role/`joined_at = now()`.
- DIRECT chats answer `422 CHAT_MEMBERSHIP_UNSUPPORTED` for add/role/remove/leave/invites;
  `GET /members` still returns both participants for DIRECT.
- Chat limits are untouched: membership mutations never check or consume
  `max_chats_per_user`/`max_chats_per_workspace`.

**Invite links** (`ChatInviteService`): raw token = 32 random bytes base64url (43 chars),
SHA-256 hex persisted; token returned once and never re-readable. Create/list/revoke are
OWNER/ADMIN-only; OWNER cannot be invited. Accept resolves the workspace inside the SQL
function (the accept URL has no workspace), is idempotent for existing ACTIVE members, and
maps `REVOKED/EXPIRED/EXHAUSTED` to `410` with distinct codes. Accept is rate-limited per
user (10/min default) and create per chat (30/h default) through new
`RateLimitPort.checkInviteAccept/checkInviteCreate` windows that are independent of the
message-send and prekey-claim windows.

**Audit**: `chat.member.added`, `chat.member.role_changed`, `chat.member.removed`,
`chat.member.left`, `chat.invite.created`, `chat.invite.revoked`, `chat.invite.accepted`,
`user.blocked`, `user.unblocked`. Metadata contains user/invite ids, roles, `max_uses`
(`UNLIMITED` when null) and `expires_at` only — never email, display name, content, token or
token hash. No-op repeats (same role, idempotent add/leave/block/revoke) write no extra
audit event.

**Blocks** (`UserBlockService`): identity-scoped (no workspace dimension), self-only reads,
idempotent block/unblock, list exposes `user_id + blocked_at` only. No email is sent
anywhere; there is no invitation email flow.

### 4. Read model / API mapping

`ChatMembersQueryService` now returns `ChatMemberListView` (flat `user_ids` + detailed
`members`) built from `chat.member_directory`; `GET /chats/{chatId}/members` still requires
an ACTIVE participant and still returns the same `user_ids` projection used by the group-call
picker. `ChatApiMapper` maps all new views to the contract DTOs; controllers stay thin.

## Tests

New `backend/src/test/java/ru/krug/backend/integration/ChannelMembersIT.java` (7 tests):

1. Member list details + legacy `user_ids`, no email/devices in the payload, non-member 404,
   DIRECT member list.
2. Add/role/idempotent add, ADMIN ceiling, self-add, non-workspace target, invalid role,
   DIRECT 422, and "add does not consume a chat-limit slot" with limits pinned at current
   usage.
3. Remove/leave: soft removal, ADMIN cannot remove OWNER, REMOVED member loses member-list
   access, last-OWNER leave/delete 409, idempotent leave, re-add of a REMOVED member, DIRECT
   leave 422.
4. Invites: hash-only persistence (no `token` column, `token_hash = sha256(token)`), metadata
   list without token, idempotent accept for an existing member, join with the invite role,
   max-uses exhaustion 410, expiry 410, idempotent revoke + 410, unknown token 404,
   non-workspace caller 403, non-manager 403, OWNER/invalid bounds 400, DIRECT 422 and
   audit metadata keys.
5. Blocks: idempotent block/unblock, single audit row, self-scoped list (another user sees an
   empty list), no email/display name, self-block 400, unknown user 404.
6. Schema backstops: FORCE RLS on `chat.invites`/`auth.user_blocks`, app grants, indexes,
   no PUBLIC EXECUTE on the new functions, cross-tenant invite/block invisibility.
7. Audit minimisation for `chat.member.added`/`role_changed`/`removed` (ids/roles only, no
   display name/email).

New `backend/src/test/java/ru/krug/backend/unit/ChannelMembersDomainTest.java` (5 tests):
token shape/hash stability (`InviteTokens`), invite status precedence and DDL bounds
(`ChatInvite`), fail-closed outcome parsing, role ceiling/last-OWNER domain policy, and the
independent invite rate-limit windows (`InMemoryRateLimiter`).

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 610, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

Baseline was 598 tests (ArchUnit's 10 rules are part of that total); the 12 new tests bring
the suite to 610, with ArchUnit still 10/10.

`npm run contract:check` — 87 operations, 126 contract schemas (71 paths), generated types in
sync. `npx tsc -p tsconfig.json --noEmit` — exit 0.

Environment note: this machine's default `mvn` runs on JDK 26, where the pre-existing Mockito
tests fail in Byte Buddy (`Java 26 (70) is not supported`). The suite must be run with JDK 21
(`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home`),
which is the project baseline; all 610 tests pass there. No test was disabled or skipped.

## Compatibility / rollout

- Additive contract and DB only. `ChatMemberIds.user_ids` is preserved; existing clients keep
  working. Existing GROUP channels already have ACTIVE participant rows (V38), so the member
  detail list is populated immediately.
- `chat.invites` and `auth.user_blocks` are new tables; V39 visibility data is untouched.
- `chat.accept_invite` / `chat.member_directory` rely on the same DBA-provisioned
  SECURITY DEFINER split (owner able to read FORCE-RLS tables) that V24/V27/V30 already use;
  RLS itself is not weakened. The functions still re-check `ops.current_user_id()` and the
  caller's ACTIVE membership.
- Rollback: drop the three functions, `auth.user_blocks` and `chat.invites` (and the new
  partial index). Invite/block data is lost; chats, participants, messages and V39 settings
  are untouched.

## Out of scope

- Sending invitation emails (none were added; the link token is returned once to the caller).
- Workspace-level invites (`/workspaces/{id}/invites`) — this slice is channel-level only.
- Enforcing blocks on message delivery/DIRECT creation; blocks are stored and exposed, but no
  existing fan-out rule was changed in P0-1.
- Frontend UI for the new endpoints (only `schema.d.ts` was regenerated plus the contract
  guard counts).

## Files

Created:

- `backend/src/main/resources/db/migration/V40__chat_members_invites_and_blocks.sql`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatMemberRow.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatInvite.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/InviteAcceptance.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/service/InviteTokens.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/service/ChatMemberPolicy.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatInviteRepository.java`
- `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/ChatInviteRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/chat/application/command/ChatInviteCreateCommand.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatMemberView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatMemberListView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatMemberAddResult.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatMembershipContext.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatInviteView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatInviteCreatedView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/InviteAcceptanceView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatMemberAccessService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatMemberManagementService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatInviteService.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatMemberController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatInviteController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatMemberResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/AddChatMemberRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChangeChatMemberRoleRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatInviteResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatInviteCreatedResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatInviteListResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatInviteCreateRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/InviteAcceptResponse.java`
- `backend/src/main/java/ru/krug/backend/auth/domain/model/UserBlock.java`
- `backend/src/main/java/ru/krug/backend/auth/domain/model/UserBlockMutation.java`
- `backend/src/main/java/ru/krug/backend/auth/domain/repository/UserBlockRepository.java`
- `backend/src/main/java/ru/krug/backend/auth/infrastructure/persistence/UserBlockRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/auth/application/model/BlockedUserView.java`
- `backend/src/main/java/ru/krug/backend/auth/application/usecase/UserBlockService.java`
- `backend/src/main/java/ru/krug/backend/auth/api/dto/BlockedUserResponse.java`
- `backend/src/main/java/ru/krug/backend/auth/api/dto/BlockedUserListResponse.java`
- `backend/src/main/java/ru/krug/backend/auth/api/UserBlockController.java`
- `backend/src/test/java/ru/krug/backend/integration/ChannelMembersIT.java`
- `backend/src/test/java/ru/krug/backend/unit/ChannelMembersDomainTest.java`

Modified:

- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `frontend/scripts/check-contract.mjs` (contract guard counts/coverage)
- `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
- `backend/src/main/java/ru/krug/backend/shared/infrastructure/config/KrugProperties.java`
- `backend/src/main/java/ru/krug/backend/ops/application/port/RateLimitPort.java`
- `backend/src/main/java/ru/krug/backend/ops/infrastructure/ratelimit/InMemoryRateLimiter.java`
- `backend/src/main/resources/application.yml`
- `backend/src/main/resources/application-test.yml`
- `backend/src/test/java/ru/krug/backend/support/TestProperties.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/Chat.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatRepository.java`
- `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/ChatRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatMembersQueryService.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatMemberIdsResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/mapper/ChatApiMapper.java`
