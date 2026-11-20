# Channel icons/avatars + cover apply-path verification — backend report

**Verdict: DONE**

GROUP channels now have an icon/avatar that references an existing managed attachment of the
same chat (no new upload pipeline), exactly like the P0-2 cover. `Chat`/`ChatSummary` expose
`avatar_file_id`, `POST/DELETE/GET /chats/{chatId}/avatar` are implemented, V45 adds the
column/FK, and the cover apply path (`PATCH /chats/{chatId}` + `POST /chats/{chatId}/cover`)
is verified end-to-end by a new regression test. Contract changes are additive; no existing
RLS policy or grant was weakened.

## What changed

### 1. Contract (`contracts/openapi.yaml`, additive)

| Item | Semantics |
|---|---|
| `Chat.avatar_file_id` | Nullable uuid, GROUP only, `null` for DIRECT/unset. Read-only in this projection: set/clear through the avatar endpoints only. |
| `ChatSummary.avatar_file_id` | Same value in the list projection, so a channel icon is visible without a second call. |
| `POST /chats/{chatId}/avatar` | `{file_id}` references an existing managed attachment of the same chat: `image/*`/`media.kind=IMAGE`, READY/BOUND + CLEAN/SKIPPED — exactly the cover rules. Chat OWNER/ADMIN; GROUP only. 404 unknown/foreign/other-chat, 422 `CHAT_AVATAR_INVALID`, 409 `ATTACHMENT_NOT_READY`, 423 `ATTACHMENT_QUARANTINED`. Idempotent repeat is 200 without a second audit. Returns the updated `Chat`. |
| `DELETE /chats/{chatId}/avatar` | OWNER/ADMIN; idempotent 204; the attachment itself is not deleted. |
| `GET /chats/{chatId}/avatar` | Any ACTIVE participant; 302 to a short-lived presigned object URL (5 min) with a `ProfileAvatar`-shaped body (`url`, `expires_at`). 404 when unset/DIRECT/not a participant — the storage key is never exposed. |

New schema `ChatAvatarRequest` (`file_id` required uuid). The `Error` description catalog
gains `CHAT_AVATAR_INVALID` and mentions the avatar in the E2EE rule. Merged contract size:
**102 paths / 134 operations / 173 schemas** (my delta among parallel work: +1 path,
+3 operations, +1 schema).

`frontend/src/api/schema.d.ts` was regenerated (`npm run api:types`). The contract guard
`frontend/scripts/check-contract.mjs` was moved to the merged counts and gained avatar
invariants (required uuid, documented `Chat`/`ChatSummary` field, bodyless 204, 302 GET,
409/423 states). It also needed the 4 operation entries of the parallel plugin-package work,
otherwise the fixed operation-count check could not stay green; that is the only file
outside the stated zone that had to change for `npm run contract:check`.

### 2. Database — `V45__chat_avatar.sql`

- `chat.chats.avatar_file_id uuid`, FK → `file.attachments(id) ON DELETE SET NULL`, column
  comment, forward-only rollback plan.
- No new RLS policy or grant: `chat.chats` already has `ENABLE/FORCE ROW LEVEL SECURITY`
  (V3, tenant workspace GUC) and table-level `SELECT/INSERT/UPDATE/DELETE` for `krug_app`,
  so the new column inherits both. A test asserts
  `has_column_privilege('krug_app', 'chat.chats', 'avatar_file_id', …)`.
- Chat soft delete now clears both `cover_file_id` and `avatar_file_id`; the attachment rows
  stay for the normal file retention/GC flow.
- Numbering: the parallel plugin-package work claims V44, so the channel avatar is V45
  (`V45__chat_avatar.sql`). Nothing else depends on the number; if the parallel migration is
  renumbered, this one can be renumbered with it.

### 3. Application rules

| Actor | POST | DELETE | GET |
|---|---|---|---|
| ACTIVE chat OWNER/ADMIN | 200 + updated `Chat` | 204 idempotent | 302 presigned |
| ACTIVE chat MEMBER/GUEST/MODERATOR | 403 | 403 | 302 presigned |
| ACTIVE workspace member, not a participant | 404 | 404 | 404 |
| DIRECT chat | 422 `CHAT_MEMBERSHIP_UNSUPPORTED` | 422 | 404 |
| E2EE chat | 422 `CHAT_SETTINGS_E2EE_UNSUPPORTED` | 204 (clear is harmless, same as cover) | 404 when unset |

- Validation is shared with the cover through `ChatImageAttachmentRules` (same workspace,
  same chat, not deleted, image, fail-closed AV). `ChatCoverAdapter` was refactored onto the
  same helper with no behaviour change; `ChatAvatarAdapter` adds the presigned download.
- Setting the same avatar is a no-op with no second audit; DELETE writes no audit when
  nothing changed. Audit action `chat.avatar.updated` carries only `{"changed":"avatar"}` —
  never a file id or storage key.
- `avatar_file_id` is not accepted by `PATCH /chats/{chatId}`: the avatar has its own
  endpoint pair, so `PATCH` cannot silently replace it; `PATCH` also keeps the cover and the
  avatar untouched when only other settings change.
- `ChatView`/`ChatSummary`/`ChatSummaryView`/`ChatResponse`/`ChatSummaryResponse` gained
  `avatar_file_id`; the list query appends the column after the existing positional columns
  so no previous index shifted.

### 4. Cover apply path — verified, no backend defect found

Both cover write paths were exercised against the real stack:

1. `PATCH /chats/{chatId}` with `cover_file_id` → the response `Chat.cover_file_id` is the
   new attachment, the list `ChatSummary.cover_file_id` matches, the DB column is updated,
   and `chat.updated` records the changed field name only (no file id).
2. `POST /chats/{chatId}/cover` → the same checks, plus `chat.cover.updated`.

A subsequent `PATCH` that changes only `read_only` keeps both the cover and the avatar, and
they remain visible in the list. No lost update or stale view was found in the application
layer (`ChatViewAssembler` re-reads the summary inside the same transaction), so this slice
adds the regression test rather than a behaviour change. The frontend already reads
`chat.cover_file_id` and applies the `POST /cover` response through `applyChatSummary`; no
contract mismatch on that path.

## Tests

New `backend/src/test/java/ru/krug/backend/integration/ChatAvatarIT.java` (4 tests):

1. **Lifecycle** — owner sets an uploaded CLEAN image, `Chat`/`ChatSummary` expose it, the
   MEMBER gets a 302 presigned `ProfileAvatar`, idempotent repeat writes no second audit,
   SKIPPED replaces it, MEMBER 403, non-participant 404, DELETE idempotent with audit only on
   a real removal, GET 404 afterwards, DIRECT 422/404.
2. **Validation** — real text upload 422 `CHAT_AVATAR_INVALID`, PENDING 409, INFECTED 423,
   other-chat/unknown/cross-tenant attachment 404, no state/audit change on rejection,
   missing body 400.
3. **Schema/RLS/backstops** — V45 column and FK exist, `chat.chats` keeps FORCE RLS + column
   privileges, dangling FK rejected, cross-tenant attachment invisible, soft delete clears
   the avatar while keeping the attachment.
4. **Cover apply path** — `PATCH` and `POST /cover` both return the updated `Chat` and appear
   in `GET /workspaces/{id}/chats`, coexist with the avatar, and survive an unrelated
   settings `PATCH`; audits stay metadata-only.

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
JAVA_HOME=<jdk21> mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 758, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

All avatar/channel/contract suites are green in the same run:

```
ChatAvatarIT            4/4
ChannelSettingsIT      10/10   (cover, rights, pins, archive, delete)
ChannelMembersIT        7/7
ChannelVisibilityIT     6/6
ChatSettingsIT          4/4
ContractValidationIT    4/4
ProfileWorkspace82IT   29/29
FileContractIT          2/2
ArchitectureTest       10/10   (ArchUnit)
```

The workspace is shared with parallel slices in the same branch, so the 758 include the
parallel plugin-package and frontend-rich-text tests; none of them was disabled or skipped,
and the run above is the full merged module (`BUILD SUCCESS`).

Environment note: the default `mvn` on this machine runs on JDK 26, where pre-existing
Mockito/Byte Buddy tests fail (`Java 26 (70) is not supported`). The suite above was run with
`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home`, the
project baseline.

Frontend checks: `npm run contract:check` — passed (134 operations, 173 schemas, generated
types in sync). `npx tsc -p tsconfig.json --noEmit` fails only in the parallel plugin-package
frontend files (`src/mocks/db.ts`, `src/plugins/model.ts`), not in the generated schema or any
file touched here.

## Files

Created:

- `backend/src/main/resources/db/migration/V45__chat_avatar.sql`
- `backend/src/main/java/ru/krug/backend/chat/application/port/ChatAvatarPort.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatAvatarView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatAvatarService.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatAvatarRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatAvatarResponse.java`
- `backend/src/main/java/ru/krug/backend/file/infrastructure/adapter/ChatImageAttachmentRules.java`
- `backend/src/main/java/ru/krug/backend/file/infrastructure/adapter/ChatAvatarAdapter.java`
- `backend/src/test/java/ru/krug/backend/integration/ChatAvatarIT.java`

Modified:

- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `frontend/scripts/check-contract.mjs` (contract guard counts/coverage/invariants)
- `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatSummaryResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/mapper/ChatApiMapper.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatSummaryView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatViewAssembler.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatQueryService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatCreateService.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChannelSettings.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatSummary.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatRepository.java`
- `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/ChatRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/file/infrastructure/adapter/ChatCoverAdapter.java`
  (shared attachment rules, behaviour unchanged)

## Out of scope

- No new upload pipeline, image transform/crop or CDN: the avatar is an existing attachment id.
- No avatar field in `PATCH /chats/{chatId}` and no avatar in `GET /sync`; the list/chat
  projections and the avatar endpoints are the complete surface.
- No avatar for DIRECT chats (the contract keeps the field `null` and the endpoints answer
  404/422). E2EE has no avatar by construction in this slice (defense-in-depth guard).
- No frontend UI wiring for the new endpoints (only the regenerated `schema.d.ts` and the
  contract guard); the existing design cover stays as the fallback when `avatar_file_id` is
  unset.
- The avatar is not propagated through realtime/outbox events; clients refresh the chat list
  as they already do for cover/settings.
