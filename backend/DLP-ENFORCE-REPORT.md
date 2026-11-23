# #101 — DLP enforcement for attachments, edits and plugin payloads; session timeout and retention

**Verdict: DONE**

All three parts of #101 are implemented as real enforcement points, not stored
preferences:

1. DLP now evaluates attachment metadata (name / base name / extension / MIME / size) on
   upload, bind and rename, re-evaluates edited message text, and evaluates plugin payloads
   (poll question/options, task title, translation input/output).
2. `session_timeout_minutes` is enforced server-side with a `last_activity` marker and a
   refresh-time idle guard.
3. `retention_days` is enforced by a daily, bounded, idempotent, tenant-scoped job with
   per-workspace counters.

Backend suite: **1042 tests, 0 failures, 0 errors** (JDK 21); ArchUnit **10/10**.
Contract: **162 operations / 213 schemas**, generated types in sync
(`npm run contract:check`).

> Migration conflict note: a parallel slice created
> `V56__workspace_invite_email.sql` while this work was in progress. This slice's migration
> was renamed to **`V57__dlp_attachment_plugin_retention_session.sql`** so both apply in
> order. No schema or test expectation depends on the old number.

---

## 1. DLP coverage

### 1.1 Policy model (additive, still literal — never regex)

`workspace.dlp_policies` gained two additive columns (V57):

| Column | Meaning |
|---|---|
| `scope` (`ALL` default, `TEXT`, `ATTACHMENT`, `PLUGIN`) | Which managed surface the rule applies to. Existing rules become `ALL`, i.e. the conservative superset. |
| `max_file_size_bytes` (nullable, 1 B…10 GiB) | Attachment-only size threshold. A file larger than the threshold matches the rule even when `pattern` does not. `NULL` = no threshold. |

The pattern remains a bounded literal (`KEYWORD` substring or `PATTERN` with `*` only);
`DlpMatcher` still compiles **no** regular expression and keeps the linear two-pointer glob.
`DlpMatcher.attachmentHaystacks(...)` produces four bounded views without reading bytes:
full file name, base name, extension (without dot), MIME type. A path is reduced to its base
name. `scope` narrows a rule; `ALL` applies to every surface.

API/contract: `DlpPolicy`, `DlpPolicyCreateRequest` and `DlpPolicyUpdateRequest` carry the
two new optional fields. This is additive (no new paths or schemas); generated
`frontend/src/api/schema.d.ts` was regenerated. `max_file_size_bytes` is rejected with `400`
for `TEXT`/`PLUGIN` rules instead of being silently ignored. (PATCH keeps the stored size
threshold when the field is absent; clearing is not part of this additive contract.)

### 1.2 Enforcement map

A single implementation, `WorkspaceDlpEnforcementService`, now implements both the original
message-send `DlpGuardPort` and the new shared `ContentDlpPort`:

| Surface | Call site | Behaviour on match |
|---|---|---|
| Message text (existing) | `MessageSubmissionHandler` | `WARN` event joins the message transaction; `BLOCK` writes an independent event and throws `422 DLP_BLOCKED` before `seq` allocation. |
| Edited text (**new**) | `MessageActionsService.edit`, after validation/version checks, before `UPDATE` | `WARN` records an event and commits the edit; `BLOCK` writes an independent event, throws `422 DLP_BLOCKED`; the stored text and `version` are unchanged. |
| Attachment upload (**new**) | `InitUploadHandler` (chat multipart) and `WorkspaceFileUploadHandler` (workspace file), after the file-type policy and before any upload/quota/object write | `BLOCK` → `422 DLP_BLOCKED`; no upload row, no quota reservation, no object bytes. |
| Attachment bind (**new**) | `MessageAttachmentService.bind`, after the AV state check and before the row is bound | Re-evaluates metadata so a rule created after the upload cannot be bypassed. `BLOCK` rolls the whole message transaction back and writes an independent event. |
| Attachment rename (**new**) | `FileMutationService.rename`, before the row update | A rename to a blocked name is rejected; the stored name is unchanged. |
| Plugin poll (**new**) | `PollService.create`, after validation and before the idempotency reservation | Question and every option are checked independently. `BLOCK` → `422 DLP_BLOCKED`; no poll, options or idempotency reservation. |
| Plugin task (**new**) | `TaskService.create`, after validation and before the idempotency reservation | Title is checked (tasks have no description field in this codebase). `BLOCK` leaves no task/reservation. |
| Plugin translate (**new**) | `TranslateMessageService.translate` | Input is checked **before** the provider call; the provider result is checked again before it is returned/audited. `BLOCK` → `422 DLP_BLOCKED`, no content returned. |

Cache: one settings read + one policy read per enforcement call (rules are capped at 100 per
workspace); no policy text or payload is logged.

### 1.3 Block / quarantine consistency

The two states are deliberately distinct and consistent with the rest of the file pipeline:

- **AV quarantine** remains the malware verdict (`423 ATTACHMENT_QUARANTINED`). It is
  checked first at bind, so a malware-quarantined file keeps its existing 423 semantics.
- **DLP block** is a policy verdict (`422 DLP_BLOCKED`). It never marks a file `QUARANTINED`
  or `INFECTED`; a blocked upload leaves no row/object at all, and a blocked bind leaves the
  attachment unbound/private (not delivered). The message transaction rolls back, so no
  partial message/attachment state exists.
- **Audit** for every decision is the append-only, content-free `workspace.dlp_events` row
  (`id`, nullable `policy_id`, rule-name snapshot, `action`, `actor_id`, nullable `chat_id`,
  `created_at`). It is the same log for text, edits, attachments and plugins. The event
  table has no text/ciphertext/filename/email/IP column; the API response is unchanged and
  contains no evaluated value. The `422` details expose only `policy_id`, `action` and
  `surface` (`TEXT`/`ATTACHMENT`/`PLUGIN`) so a client can render the correct error without
  learning the rule content.

Tests assert that `top-secret`, file names, poll questions, task titles and translated text
never appear in the response or in `row_to_json(dlp_events)`.

---

## 2. Session timeout (`session_timeout_minutes`)

This is a real server-side idle-timeout implementation, not a UI-only value.

- **Tracking** — `auth.session_activity` (V57) stores `session_id` (Keycloak `sid`),
  `user_id`, `first_seen_at`, `last_activity_at`. It is `ENABLE` + `FORCE RLS`, self-scoped
  (`user_id = ops.current_user_id()`), and stores no token, IP, user agent, device label or
  content. `SessionActivityFilter` runs after device binding on authenticated
  `/api/v1/**` requests and touches the marker. It never rejects a request; a marker-store
  failure is fail-open for availability.
- **No idle-clock reset by refresh** — `/api/v1/auth/**` is excluded from tracking, so a
  silently refreshing abandoned tab still expires. Only a real API request counts as user
  activity.
- **Enforcement** — `SessionTimeoutGuard` is called by `RefreshSessionService` after the
  Keycloak exchange and the 2FA policy check. It resolves the strictest ACTIVE workspace
  `session_timeout_minutes` through
  `workspace.effective_session_timeout_minutes(user_id)` (a narrow SECURITY DEFINER
  function that re-checks the caller) and compares it to the marker. If the session has been
  idle longer than the window, the newly minted refresh token is revoked (best-effort) and
  the API answers `401 AUTH_SESSION_EXPIRED`; no new token pair reaches the browser.
- **First refresh** — a missing marker is bootstrapped and allowed (login itself is not an
  API activity event), so a fresh login is never rejected.
- **Multiple workspaces** — the shortest (strictest) active policy wins, so a permissive
  workspace cannot extend a session governed by a stricter one.
- **No `sid`** (dev tokens, non-Keycloak issuers) — tracking and enforcement are skipped
  explicitly; no fake timeout is reported.

Residual window: an access token that was already issued remains valid until its normal
IdP TTL. Configure the Keycloak access-token lifespan below the minimum workspace timeout
(15 minutes); refresh is the only path that can extend a session, and that path is now
closed. This trade-off is explicit in the code and in this report rather than hidden behind
a no-op.

Tests: `SessionTimeoutGuardTest` (decision table, boundary, no marker, no policy, refresh
does not touch), `SessionActivityIT` (self-scoped RLS, content-free columns, 16 min idle
allowed under 60 then rejected after narrowing to 15, dev session not tracked).

---

## 3. Workspace retention (`retention_days`)

`WorkspaceRetentionService` runs daily (`WorkspaceRetentionScheduler`, cron
`krug.retention.workspace-cron`, default `0 30 3 * * *`; disabled by
`krug.retention.enabled=false`, which the test profile uses).

Targets are ACTIVE workspaces with a security-settings row, read through the
transaction-local `retention` worker role and the narrow `workspace.retention_targets()`
function. Each workspace is processed with its own cutoff `now - retention_days`:

- **Messages** — bounded batch (default 500, at most 20 batches per workspace per run)
  soft-deletes messages older than the cutoff: `deleted_at` set, `deleted_by` cleared,
  `body_ciphertext` and `content_meta` cleared, mention metadata cleared, `version`
  incremented. E2EE envelopes and reactions for the same messages are deleted. The row and
  its `seq` are kept, so timeline pagination/audit references stay stable.
- **Attachments** — bounded batch flips `file.attachments` to `DELETED` and sets
  `deleted_at`; the backing `file.uploads` row is set to `EXPIRED`. After the DB transaction
  commits, the orchestrator deletes the object bytes through `ObjectStoragePort`. A failed
  object-store delete is logged by exception class only; the DB row is already unreachable.
- **Idempotent** — only rows that are not already tombstoned/`DELETED` are selected; a
  repeated run (or a crash between batches) deletes nothing twice. The batch query uses
  `FOR UPDATE SKIP LOCKED`.
- **Bounded** — `batch-size` × 20 per workspace per run; leftover older rows are drained by
  the next daily run. A failure in one workspace does not stop the others.
- **Counters** — `workspace.retention_runs` stores one row per workspace run:
  `started_at`, `finished_at`, `retention_days`, `messages_deleted`, `files_deleted`,
  `batches`, `status` (`COMPLETED`/`FAILED`) and a bounded exception class in `error_code`.
  It stores no content and no exception message. The table is tenant-RLS-scoped, so an
  OWNER/ADMIN can read the counters with SQL under the normal tenant context. A dedicated
  admin HTTP endpoint for the last run was optional and is not added in this slice; the
  `retention_runs` row is the status record.
- **Legal holds** — this codebase has no legal-hold feature or table, so there is nothing
  to skip today. A compliance deployment must add a per-message/per-file hold flag and an
  explicit predicate in the batch SQL before relying on retention for deletion. This is
  called out here rather than silently ignored.
- **Quota** — retention only frees storage, never consumes it. `used_bytes` is restored by
  the existing daily quota reconciliation (`QuotaReconciliationHandler`), which recomputes
  from live attachments; the next run also finds no rows twice. No over-quota condition can
  result.
- **RLS** — every batch runs in a transaction with `app.workspace_id` set, so normal tenant
  policies apply to messages/attachments/uploads/envelopes/reactions. The only cross-tenant
  read is the settings target list, and it is gated in SQL by
  `ops.current_worker_role() = 'retention'`.

Tests: `WorkspaceRetentionServiceTest` (batching, cutoff per workspace, cap, idempotence,
failure isolation, counters) and `WorkspaceRetentionIT` (old vs fresh message, real uploaded
attachment + object deletion, counters, repeat run no-op, cross-tenant isolation).

---

## 4. Database — V57

Additive migration `V57__dlp_attachment_plugin_retention_session.sql`:

- `workspace.dlp_policies.scope` + `max_file_size_bytes` (with checks and comments).
- `auth.session_activity` (self-RLS, grants `SELECT/INSERT/UPDATE/DELETE`).
- `workspace.effective_session_timeout_minutes(uuid)` — `SECURITY DEFINER`, caller-checked,
  `REVOKE PUBLIC` + `EXECUTE` to `krug_app`.
- `workspace.retention_runs` (tenant FORCE RLS, `SELECT/INSERT/UPDATE` only).
- `workspace.retention_targets(integer)` — `SECURITY DEFINER`, retention-worker-checked,
  `REVOKE PUBLIC` + `EXECUTE` to `krug_app`.
- `ck_messages_bot_text` replaced so a soft-deleted BOT row may clear its body; all other
  bot shape invariants are unchanged.
- `ix_messages_ws_created` partitioned index (inherited by current and future partitions;
  `message.ensure_partition()` updated) and `ix_attachments_ws_created_live`.

Rollback plan is in the migration header (drop the two functions, three new objects/columns,
and restore the V4 partition function body). Retention counters, session markers and DLP
scope/size settings are lost on rollback; messages, files, DLP rules and audit rows are not.

No RLS policy was weakened. The new cross-tenant functions are read-only/lookup helpers
gated on the transaction-local worker role or the caller id; actual deletion runs under
tenant RLS.

---

## 5. Tests and evidence

New coverage (30 tests):

| Test class | Tests | Coverage |
|---|---:|---|
| `WorkspaceDlpCoverageIT` | 4 | Attachment upload block (no upload row), bind recheck after a later rule, content-free events + DB rows, edit BLOCK keeps original/version, edit WARN commits, poll question/options BLOCK (no poll/options), task title BLOCK, translation input BLOCK before provider, clean poll still succeeds, cross-tenant rule isolation |
| `WorkspaceRetentionIT` | 2 | Old vs fresh message, real attachment object deletion + `DELETED`/`EXPIRED`, run counters, second run no-op, another workspace's content untouched |
| `SessionActivityIT` | 3 | Self-scoped RLS/no secrets in columns, 60-min default vs 15-min narrowed policy, dev session without `sid` not tracked, strictest-policy behavior |
| `DlpMatcherTest` (extended) | +3 | Attachment haystacks (name/stem/extension/MIME, path base name), `*.exe`/MIME matching, `DlpScope`/`DlpSurface` applicability |
| `DlpPolicyRequestsTest` (extended) | +2 | Scope literal validation/default, size-threshold bounds and attachment-only rule |
| `WorkspaceDlpEnforcementServiceTest` (extended) | +5 | Attachment filename BLOCK, size threshold, scope isolation, plugin field-by-field BLOCK/WARN |
| `SessionTimeoutGuardTest` (new) | 6 | No sid/no policy, bootstrap, recent activity, expired, exact boundary, refresh does not reset idle clock |
| `WorkspaceRetentionServiceTest` (new) | 5 | No targets, multi-batch drain + object delete, per-workspace cutoff, batch cap, one-failure isolation/counters |

Commands and results (JDK 21 — the project baseline; the machine's default `mvn` picks JDK
26 where pre-existing Mockito/Byte Buddy tests fail):

```
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
  mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 1042, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

```
cd frontend && npm run contract:check
Contract check passed: 162 operations, 213 contract schemas, generated types in sync.
```

The DLP-specific and retention/session tests were also run under the default JDK 26
individually (green); the full-suite JDK 26 failure is the known pre-existing Mockito
limitation documented in `SECURITY-REPORT.md`, not a #101 regression.

---

## 6. Limitations / rollout

- `session_timeout_minutes` is enforced at refresh (the only stateless-BFF extension path).
  Already-issued access tokens live until their IdP TTL; keep that TTL below 15 minutes.
  Dev tokens have no `sid` and are explicitly outside the policy.
- Retention has no legal-hold support because the product has no legal-hold model. Add a
  hold predicate before compliance use.
- Retention counters are exposed as a tenant-RLS table, not a new HTTP endpoint (the
  endpoint was optional). Query:
  `SELECT * FROM workspace.retention_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1`.
- A blocked bind leaves a READY/unbound attachment owned by the uploader (it is not
  delivered and not downloadable by other members). AV quarantine keeps its existing 423
  semantics. DLP block never impersonates malware quarantine.
- `max_file_size_bytes` can be set/changed but not cleared through the additive PATCH
  contract (absent = keep). A dedicated clear path can be added later.
- Direct avatar/cover/logo images use their own pipeline and are not evaluated as message
  attachments; they carry no delivered content. Attachment rules cover chat uploads,
  workspace files, bind and rename.
- Retention attachment age is the attachment creation time. A very old workspace file bound
  to a new message can therefore be expired by the file's age; the fallback daily quota
  reconciliation restores `used_bytes`.

---

## 7. Files (this slice)

Created (backend main):

- `src/main/resources/db/migration/V57__dlp_attachment_plugin_retention_session.sql`
- `workspace/domain/model/DlpScope.java`, `DlpSurface.java`
- `shared/application/port/ContentDlpPort.java`
- `auth/domain/repository/SessionActivityRepository.java`, `SessionTimeoutRepository.java`
- `auth/application/port/AccessTokenSessionPort.java`
- `auth/application/usecase/SessionActivityService.java`, `SessionTimeoutGuard.java`
- `auth/infrastructure/persistence/SessionActivityRepositoryAdapter.java`,
  `SessionTimeoutRepositoryAdapter.java`
- `auth/infrastructure/keycloak/JwtAccessTokenSessionAdapter.java`
- `auth/infrastructure/security/SessionActivityFilter.java`
- `ops/application/model/RetentionTarget.java`, `MessageRetentionBatch.java`,
  `FileRetentionBatch.java`, `WorkspaceRetentionReport.java`
- `ops/application/port/RetentionTargetDirectory.java`, `ContentRetentionPort.java`,
  `RetentionRunsPort.java`
- `ops/application/usecase/WorkspaceRetentionService.java`
- `ops/infrastructure/persistence/RetentionTargetDirectoryAdapter.java`,
  `ContentRetentionAdapter.java`, `RetentionRunsAdapter.java`
- `ops/infrastructure/scheduling/WorkspaceRetentionScheduler.java`

Created (tests):

- `integration/WorkspaceDlpCoverageIT.java`
- `integration/WorkspaceRetentionIT.java`
- `integration/SessionActivityIT.java`
- `unit/SessionTimeoutGuardTest.java`
- `unit/WorkspaceRetentionServiceTest.java`

Modified (backend): DLP policy DTO/command/view/mapper/validation/service/repository, DLP
matcher and enforcement service, message edit, file upload/bind/rename, poll/task/translate
services, `RefreshSessionService`, `SecurityConfig`, `ErrorCode`, `application.yml`,
`AuthBffErrors`, and the DLP unit tests.

Modified (contract/frontend): `contracts/openapi.yaml` (additive DLP fields + enforcement
descriptions), `frontend/src/api/schema.d.ts` (regenerated).

**Verdict: DONE**
