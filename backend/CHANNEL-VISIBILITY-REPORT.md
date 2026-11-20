# GROUP channel visibility (PUBLIC / PRIVATE) — backend report

**Verdict: DONE**

Implementation of workspace-wide PUBLIC GROUP channels and selected-user PRIVATE GROUP
channels, created by any ACTIVE workspace member within the existing installation limits.
The contract is additive, V38 is untouched, and existing membership/RLS semantics are
unchanged.

## What changed

### 1. Contract (`contracts/openapi.yaml`)

| Schema | Additive fields |
|---|---|
| `ChatCreateRequest` | optional `visibility` (`PUBLIC`/`PRIVATE`/`null`; defaults to `PUBLIC` in the service), optional `member_ids` (`uuid[]`, `maxItems: 100`, `uniqueItems: true`) |
| `Chat` | optional `visibility` (`GROUP` only; `null` for `DIRECT`) |
| `ChatSummary` | optional `visibility` (`GROUP` only; `null` for `DIRECT`) |

`member_ids` semantics are documented in the schema: PRIVATE only, 1..100 distinct ACTIVE
workspace members, the creator is excluded and becomes OWNER; PUBLIC/DIRECT reject ids.
`frontend/src/api/schema.d.ts` was regenerated with the project's `npm run api:types`
(openapi-typescript 7.13.0); the generated diff is limited to the new fields.

### 2. Database — V39 (`chat.channel_settings`)

New migration `V39__chat_channel_settings.sql`:

- `chat.channel_settings(chat_id uuid PK → chat.chats(id) ON DELETE CASCADE, visibility text
  CHECK IN ('PUBLIC','PRIVATE'), created_at timestamptz NOT NULL DEFAULT now())`.
- Backfill: every existing `GROUP` chat becomes `PUBLIC` (`ON CONFLICT DO NOTHING`), matching
  the V38 workspace-wide membership backfill. `DIRECT` chats get no row.
- `ENABLE` + `FORCE ROW LEVEL SECURITY`; the policy follows the owning chat
  (`c.id = chat_id AND c.workspace_id = ops.current_workspace_id()`), because the table has
  no `workspace_id` of its own.
- `GRANT SELECT, INSERT, UPDATE, DELETE ... TO krug_app`.
- Forward-only rollback note included in the migration.

### 3. Application — `ChatCreateService`

`ChatCreateCommand` carries `visibility` and `memberIds`. Validation happens before the
idempotency reservation; the canonical request hash now includes the visibility and the
sorted member-id set (so reusing an `Idempotency-Key` for a different audience is rejected
instead of replaying the wrong channel).

| Case | Behaviour |
|---|---|
| GROUP, `visibility` absent/`null` | `PUBLIC` |
| GROUP `PUBLIC` | `member_ids` must be absent/empty; creator stored as `OWNER`; every ACTIVE workspace member added as `MEMBER` (idempotent SQL) |
| GROUP `PRIVATE` | `member_ids` required 1..100, no nulls, no duplicates, no self; every id must be an ACTIVE workspace member (application check + ACTIVE-membership guard inside each insert); creator `OWNER`, selected `MEMBER` |
| DIRECT | `visibility`/`member_ids` rejected as GROUP-only; existing DIRECT behaviour is unchanged |
| E2EE GROUP | still rejected by `Chat.requireSupportedType` (`409 E2EE_GROUP_NOT_SUPPORTED`) — visibility does not relax it |
| Limits | `ChatLimitPolicy` user + workspace checks still run under the creation advisory lock |
| Authorization | any ACTIVE workspace member (`WorkspaceAccessPort.requireActiveMember`), admins are not required |
| Audit | one `chat.created` event with `target_type=chat`, `target_id=<chat id>` and metadata **only** `visibility` + `member_count`; selected user ids, names and content are never written |

Response `Chat.visibility` is `PUBLIC`/`PRIVATE` for GROUP and `null` for DIRECT.

### 4. New-member auto-join — published chat port

New published port `ChatChannelMembershipPort` (+ `ChatChannelMembershipService`) exposes
`joinPublicChannels(workspaceId, userId)`. `AddWorkspaceMemberService` calls it immediately
after a successful `workspace.add_member` inside the same transaction:

- inserts an ACTIVE `MEMBER` row in every live `PUBLIC` GROUP chat of the workspace,
- never touches `PRIVATE` chats,
- is idempotent (`ON CONFLICT DO NOTHING`),
- only inserts when `workspace.memberships.status = 'ACTIVE'` (no bypass path),
- takes the same workspace advisory lock as channel creation, so a member joining while a
  PUBLIC channel is being created cannot miss that channel.

Workspace onboarding and dev bootstrap write `PUBLIC` settings for their default GROUP chat,
so «Общий чат» and dev channels behave exactly like API-created PUBLIC channels.

No private-channel invite links were added.

### 5. Read models / API

`ChatSummary` (domain + application view + API DTO) and `ChatView`/`ChatResponse` now carry
`visibility`; `ChatApiMapper` maps it for `GET /workspaces/{id}/chats`, `POST
.../chats` and `PATCH /chats/{id}`. The existing list query joins
`chat.channel_settings` and returns visibility only for GROUP. Membership visibility is
unchanged: a channel appears in a user's list only through an ACTIVE `chat_members` row.

## Tests

New `backend/src/test/java/ru/krug/backend/integration/ChannelVisibilityIT.java` (6 tests):

1. PUBLIC is the default, every ACTIVE member joins, explicit empty `member_ids` is
   accepted, list summaries expose `PUBLIC`, audit has only visibility + count.
2. PRIVATE contains only creator (OWNER) and selected (MEMBER), outsiders are not added,
   list exposes `PRIVATE`, audit contains no user ids.
3. Invalid lists: empty, self, duplicate, foreign/non-member, unknown, 101 ids; PUBLIC with
   ids; invalid visibility literal; DIRECT with visibility/ids. All rejected without
   consuming a limit slot or persisting a chat.
4. Any ACTIVE non-admin member can create a GROUP, but the per-user installation limit still
   returns `409 CHAT_LIMIT_REACHED`; after raising the limit the creation succeeds.
5. Adding a new workspace member auto-joins the default and both explicit PUBLIC channels,
   including channels created before the join, and never joins a PRIVATE channel.
6. V39 schema: `channel_settings` has FORCE RLS and app grants; another tenant sees zero
   rows; every live GROUP chat in the workspace has a settings row; DIRECT has none; the
   `PUBLIC` backfill is idempotent.

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 598, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0
BUILD SUCCESS
```

`npm run contract:check` — `76 operations, 116 contract schemas`, generated types in sync.
`npx tsc -p tsconfig.json --noEmit` — exit 0.

## Compatibility / rollout

- Additive only: no existing DB column/constraint or contract field was changed; V38 is
  untouched and V39 runs after it.
- Existing GROUP chats are backfilled as `PUBLIC`, preserving pre-feature behaviour (all
  ACTIVE members already had participant rows from V38).
- Existing clients that omit `visibility`/`member_ids` keep creating PUBLIC workspace
  channels.
- Rollback: `DROP TABLE chat.channel_settings;` loses visibility settings only; chats,
  members, messages and V38 data are untouched.

## Out of scope

- Private-channel invite links / join requests.
- Membership/RLS rule changes (none were made).
- Frontend UI for choosing visibility (only the generated `schema.d.ts` types were
  refreshed).

## Files

Created:

- `backend/src/main/resources/db/migration/V39__chat_channel_settings.sql`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChannelVisibility.java`
- `backend/src/main/java/ru/krug/backend/chat/application/port/ChatChannelMembershipPort.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatChannelMembershipService.java`
- `backend/src/test/java/ru/krug/backend/integration/ChannelVisibilityIT.java`

Modified:

- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatCreateService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatProvisioningService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatQueryService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/usecase/ChatUpdateService.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatView.java`
- `backend/src/main/java/ru/krug/backend/chat/application/model/ChatSummaryView.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/model/ChatSummary.java`
- `backend/src/main/java/ru/krug/backend/chat/domain/repository/ChatRepository.java`
- `backend/src/main/java/ru/krug/backend/chat/infrastructure/persistence/ChatRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/chat/api/ChatController.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatCreateRequest.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/dto/ChatSummaryResponse.java`
- `backend/src/main/java/ru/krug/backend/chat/api/mapper/ChatApiMapper.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/AddWorkspaceMemberService.java`
