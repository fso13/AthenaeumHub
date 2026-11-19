# MSG-ACTIONS (#61–#63) — reactions, message edit and delete

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Rest of `frontend/**`, `docs/**`, `design/**`, `deploy/**` untouched. The workspace is
> not a git checkout, so the change set is verified in the working tree and by tests.

## Status

**DONE in the scope of #61–#63.** Delivered:

* `POST /chats/{chatId}/messages/{messageId}/reactions` `{emoji}` → `200 ReactionSummary`;
* `DELETE /chats/{chatId}/messages/{messageId}/reactions/{emoji}` → `204` (idempotent);
* `PATCH /chats/{chatId}/messages/{messageId}` `{text, version?}` → `200 Message`;
* `DELETE /chats/{chatId}/messages/{messageId}?scope=me|all` → `204` (idempotent);
* `Message.reactions[]` aggregated per page in one query, caller-relative `me`;
* WS `message.updated`, `message.deleted`, `message.reaction.changed` (flat `Message`
  payload for update, tombstone/reaction payloads for the other two);
* V31: `message.message_reactions`, `message.message_deletions`, indexes, forced RLS and
  `krug_app` grants;
* managed-only edit/reactions (`422 E2EE_METADATA_FORBIDDEN` in E2EE), sender-only edit
  and delete-for-all; delete-for-me is caller-local; delete-for-all is a soft tombstone
  (no message row is physically deleted; body ciphertext, E2EE envelopes, reactions and
  downloadable attachments are cleared/hidden).

Full backend suite: **515/515**, `ArchitectureTest`: **10/10** (JDK 21).

## 1. Contract (additive)

`contracts/openapi.yaml` — previously **48 paths / 56 operations / 88 schemas**; now
**51 / 60 / 91** (+3 paths, +4 operations, +3 schemas):

| Operation | Path | Request | Responses |
|---|---|---|---|
| `editMessage` | `PATCH /chats/{chatId}/messages/{messageId}` | `MessageEdit {text:1..8000, version?}` | `200 Message`; 400/401/403/404/409/422 |
| `deleteMessage` | `DELETE /chats/{chatId}/messages/{messageId}?scope=me\|all` | query `scope` (default `me`) | `204`; 400/401/403/404/422 |
| `addMessageReaction` | `POST /chats/{chatId}/messages/{messageId}/reactions` | `ReactionCreate {emoji}` | `200 ReactionSummary`; 400/401/403/404/422 |
| `removeMessageReaction` | `DELETE /chats/{chatId}/messages/{messageId}/reactions/{emoji}` | path `emoji` | `204`; 400/401/403/404/422 |

* `Message.reactions` — additive optional array of `ReactionSummary` (`emoji`, `count`,
  `me`); not in `required`, so existing clients/types stay source-compatible.
* New schemas: `MessageEdit`, `ReactionCreate`, `ReactionSummary`; new
  `MessageId`/`Emoji` path parameters.
* `Error.code` notes: `E2EE_METADATA_FORBIDDEN` (422), `MESSAGE_NOT_EDITABLE` (422),
  `MESSAGE_TOO_LONG` (422), `VERSION_CONFLICT` (409).
* `frontend/src/api/schema.d.ts` is regenerated with `npm run api:types`; `tsc --noEmit`
  passes. **Known external guard:** `frontend/scripts/check-contract.mjs` hardcodes
  `48/88/56` and therefore fails until the frontend owner updates those counts; the
  script is outside this task's zone (only `schema.d.ts` is allowed in `frontend/`).

`contracts/ws-protocol.md` adds:

| Event | Payload |
|---|---|
| `message.updated` | flat `Message` (new `text`, `version`, `edited_at`, `reactions`) |
| `message.deleted` | `message_id`, `chat_id`, `seq`, `deleted_at`, `deleted_by`, `scope` |
| `message.reaction.changed` | `message_id`, `seq`, `user_id`, `emoji`, `action` (`ADDED`/`REMOVED`), `count` |

Delete-for-me is deliberately **not** broadcast: only the caller's timeline changes.
These live events are not part of durable `seq` replay; replay still returns
`message.created` with the current row state (`edited_at`, `version`, `deleted_at`,
`reactions`). `event_id` is deterministic per fact so live/duplicate delivery dedupes.

## 2. V31 — schema, RLS, grants

`backend/src/main/resources/db/migration/V31__message_actions.sql`:

* `message.message_reactions` — PK `(message_id, user_id, emoji)`, `workspace_id`/`chat_id`
  denormalised (partitioned-message rule), `emoji` 1..32 chars and a DB CHECK forbidding
  whitespace/control/`<`/`>`; indexes `(workspace_id, message_id)` and
  `(workspace_id, chat_id, message_id)`; forced RLS by `ops.current_workspace_id()`;
  `GRANT SELECT, INSERT, DELETE` to `krug_app`.
* `message.message_deletions` — PK `(message_id, user_id)`, `workspace_id`/`chat_id`,
  `deleted_at`; index `(workspace_id, user_id, message_id)` for the timeline
  `NOT EXISTS`; forced RLS; `GRANT SELECT, INSERT, DELETE`.
* No FK to `message.messages`: the parent is RANGE-partitioned by `created_at`, exactly
  like `message_envelopes`; the application verifies message/chat membership and RLS
  scopes the tenant. `edited_at` already existed from V4 and is reused.
* Forward-only rollback: drop the two tables; message rows/timestamps remain.

## 3. Backend

```
backend/src/main/java/ru/krug/backend/message/
  api/MessageController.java
  api/dto/MessageEditRequest.java, ReactionCreateRequest.java, ReactionSummaryResponse.java
  api/dto/MessageResponse.java, api/mapper/MessageApiMapper.java
  application/command/DeleteMessageScope.java
  application/model/MessageEditInput.java, ReactionSummaryView.java, MessageView.java
  application/usecase/MessageActionsService.java, MessageQueryHandler.java
  application/event/MessageUpdatedNotification.java, MessageDeletedNotification.java,
                     MessageReactionNotification.java
  domain/model/MessageReaction.java
  domain/repository/MessageReactionRepository.java, MessageRepository.java
  domain/service/MessageReactionPolicy.java
  infrastructure/persistence/MessageReactionRepositoryAdapter.java
  infrastructure/persistence/MessageDeletionEntity.java
  infrastructure/persistence/MessageRepositoryAdapter.java
  infrastructure/persistence/MessageJpaRepository.java
backend/src/main/java/ru/krug/backend/realtime/
  application/service/RealtimeEventFactory.java, MessageSnapshotMapper.java
  application/model/MessageSnapshot.java
  infrastructure/event/RealtimeMessageActionsListener.java
  infrastructure/adapter/RealtimeChatHistoryAdapter.java
backend/src/main/java/ru/krug/backend/message/application/port/MessageAttachmentPort.java
backend/src/main/java/ru/krug/backend/file/application/usecase/MessageAttachmentService.java
backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java
backend/src/main/java/ru/krug/backend/shared/infrastructure/web/ApiRequestPath.java
```

### Rules chosen

* **Active membership only.** Every action calls `ChatAccessPort.requireActiveChat`;
  unknown/foreign chat or message is `404` (existence hidden).
* **Edit:** sender only, `TEXT` only, managed only, not deleted, not hidden for caller.
  `text` 1..8000; empty/whitespace → 422; `version` is an optional optimistic lock
  (`409 VERSION_CONFLICT`); server sets `edited_at`, increments `version` atomically and
  publishes `message.updated`. Owner/admin gets no special edit right.
* **Delete-for-all:** **sender only** (documented choice; owner/admin does not inherit
  it). Sets `deleted_at`/`deleted_by`, clears `body_ciphertext` and `content_meta`,
  increments `version`, keeps the row/seq. Removes reaction rows, purges E2EE envelopes,
  marks bound attachments `DELETED` (download then 410). Repeated call is `204`.
* **Delete-for-me:** any active member; one row in `message_deletions`; idempotent; no
  other member/WS subscriber is affected.
* **Reactions:** managed only; `(message,user,emoji)` unique via PK; repeat POST is 200
  and does not duplicate; DELETE is 204 even when absent. Emoji is not a closed enum:
  1..8 code points, at least one pictographic base (ZWJ/VS16/skin-tone/keycap allowed),
  no whitespace/control/HTML brackets. One aggregation query per page; no N+1.
* **E2EE:** edit and reactions return `422 E2EE_METADATA_FORBIDDEN` (server would otherwise
  create plaintext metadata around an encrypted timeline). Delete remains a content-free
  tombstone and is allowed.

### Concurrency / race handling

`editText` and `softDeleteForAll` are single atomic `UPDATE`s with the expected
`workspace_id`/`chat_id` and, for edit, optional `version`. A stale version returns 409
rather than overwriting another writer. Native updates clear the persistence context
before re-reading, so the REST response and WS frame carry the committed row.

## 4. Tests

Full backend suite on JDK 21: **515/515**, failures/errors 0, `ArchitectureTest` 10/10.

New/updated classes:

* `backend/src/test/java/ru/krug/backend/integration/MessageActionsIT.java` — reactions
  toggle/count/`me`, aggregation/contract, edit permissions/validation/version, delete-me
  isolation/idempotency, delete-all tombstone/idempotency/sender-only, foreign chat/scope,
  RLS/grants/indexes/CHECKs, direct-SQL tenant rejection.
* `backend/src/test/java/ru/krug/backend/integration/E2eeMessageIT.java` — E2EE edit and
  reaction 422, sender-only tombstone, envelope purge, tombstone has no crypto/text/
  reactions.
* `backend/src/test/java/ru/krug/backend/integration/RealtimeWebSocketIT.java` — live
  `message.updated`, `message.reaction.changed` (`ADDED`/`REMOVED`), `message.deleted`
  (`scope=all`), and no event for `scope=me`.
* `backend/src/test/java/ru/krug/backend/integration/ContractValidationIT.java` — existing
  schema checks still validate `Message`/`MessagePage` (reactions is additive).
* `backend/src/test/java/ru/krug/backend/ArchitectureTest.java` — unchanged, 10/10.
* `MessageActionsIT` also validates `Message`/`ReactionSummary` against the regenerated
  OpenAPI component schemas.

The suite was executed in `backend/`-equivalent isolated copy because several agents share
this workspace and their concurrent `mvn clean/test` runs delete `backend/target` while a
test JVM is starting. Source, `pom.xml` and the local Maven repo are identical; the copy
only provides a private `target/`.

Also fixed two unrelated test-compile blockers left by concurrent work in the shared
tree (not part of the feature): `SubscriptionServiceTest.FakeSettings` lacked the call
signal methods, and `RealtimeCallSignalingIT` passed a `SessionResponse` where a ticket
string was required.

## 5. Risks / follow-ups

1. `frontend/scripts/check-contract.mjs` still asserts exact `48 paths / 88 schemas /
   56 operations`; the contract is now `51 / 91 / 60`. The script is outside the allowed
   zone, so the frontend owner must update the constants. `schema.d.ts` itself is in sync
   and `tsc` passes.
2. `ApiRequestPath.normalized()` used to reject any surrogate, which made the required
   emoji path segment impossible (`401` before the handler). It now iterates code points
   and rejects only unpaired surrogates/controls. Existing path-smuggling protections
   (single decode, no `%`, no `;`/`\`/`..`/`//`) are unchanged; the security tests pass.
3. Live update/delete/reaction frames are not durable-replayed. This is documented in
   `ws-protocol.md`; clients reconcile through REST/`message.created` replay. Adding an
   outbox consumer for these events is a separate slice.
4. E2EE edit/reaction is intentionally unsupported rather than implemented as opaque
   ciphertext edit; the 422 code is documented in the contract.
