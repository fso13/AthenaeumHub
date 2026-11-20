# Workspace security — DLP, audit/export and sessions (P0-3 / GitHub #81) — backend report

**Verdict: DONE**

Implementation of the P0-3 workspace security surface: DLP policy CRUD with a literal
(never-regex) matcher and a MANAGED message-send gate, workspace audit page and bounded
CSV/JSON export, workspace member session list/revoke/revoke-all through the Keycloak Admin
API, and workspace security settings. The contract change is additive, V42 is new, and no
existing RLS policy or grant was weakened.

## What changed

### 1. Contract (`contracts/openapi.yaml`, additive)

Nine new paths / twelve new operations (77 → 86 paths, 97 → 109 operations, 134 → 148
schemas), grouped under the new `security` tag. All operations require an ACTIVE OWNER/ADMIN
of the workspace and the `X-Device-Id` header; a foreign/unknown workspace is `403` and a
non-manager member is `403` (existence is not disclosed).

| Operation | Semantics |
|---|---|
| `GET /workspaces/{id}/dlp/policies` | OWNER/ADMIN. Bounded list (≤100), `created_at DESC, id DESC`. E2EE → 200 empty (no usable rule); mutations in E2EE → `422 DLP_E2EE_UNSUPPORTED`. |
| `POST /workspaces/{id}/dlp/policies` | `{name, action, pattern_type, pattern, enabled?}`. `KEYWORD` = literal case-insensitive substring; `PATTERN` = same plus `*` (≤20). Name unique per workspace case-insensitively (`409 DLP_POLICY_NAME_TAKEN`), ≤100 rules (`409 DLP_POLICY_LIMIT`), pattern 1..200 printable characters, control characters rejected. No regex is compiled, so ReDoS is impossible by construction. |
| `PATCH /workspaces/{id}/dlp/policies/{policyId}` | Partial; at least one field; no-op repeat is 200 without a second audit event; unknown/foreign → 404; duplicate name → 409. A type change re-validates the wildcard bound. |
| `DELETE /workspaces/{id}/dlp/policies/{policyId}` | 204; unknown/foreign → 404. Historical events keep the rule-name snapshot (`policy_id` becomes null). |
| `GET /workspaces/{id}/dlp/events` | Exact `policy_id`/`action` filters, opaque workspace-bound cursor, `limit 1..100` (default 30), `created_at DESC, id DESC`. Content-free rows: `id`, `policy_id`, `policy_name`, `action`, `actor_id`, `chat_id`, `created_at`. |
| `GET /workspaces/{id}/audit` | Exact `action` (≤120), exact `actor_id`, inclusive `from`/`to` (`from > to` → 400), cursor, `limit 1..100` (default 30). Rows expose `id`, `action`, `actor_id`, `target_type`, `target_id`, `created_at` only. |
| `GET /workspaces/{id}/audit/export?format=csv\|json` | OWNER/ADMIN; same filters, no cursor/limit. Hard cap 10 000 rows (`X-Export-Rows`, `X-Export-Truncated`), RFC 4180 CSV or bounded JSON (`WorkspaceAuditExport`). Exporting is itself audited with `workspace.audit.exported` (format/returned/truncated only). |
| `GET /workspaces/{id}/sessions` | OWNER/ADMIN; live Keycloak sessions of ACTIVE members, `last_seen_at DESC, id DESC`, cursor, `limit 1..100` (default 50). Fields: `id`, `user_id`, `device` (client label), `created_at`, `last_seen_at`, `current` (caller `sid`). No IP/username/tokens. Keycloak down → `503 AUTH_UNAVAILABLE`. |
| `DELETE /workspaces/{id}/sessions/{sessionId}` | OWNER/ADMIN; the session must belong to an ACTIVE member of this workspace. Foreign/already-revoked → `404` without a side effect. Keycloak down → `503`. Audit stores the member id only. |
| `POST /workspaces/{id}/sessions/revoke-all` | OWNER/ADMIN; revokes all member sessions but spares the caller's current `sid`, so the administrator is not logged out. Returns `{revoked_sessions, affected_users}`; audited with counts only. |
| `GET /workspaces/{id}/security` | OWNER/ADMIN; `require_2fa`, `session_timeout_minutes` (15..10080), `dlp_enabled`, `retention_days` (1..3650), `updated_at`. No `security_mode` field: the mode is immutable. |
| `PATCH /workspaces/{id}/security` | Partial; at least one field; no-op repeat is 200 without a second audit event. Explicit `security_mode` (including the current value) → `422 MODE_CHANGE_FORBIDDEN`; `dlp_enabled=true` in E2EE → `422 DLP_E2EE_UNSUPPORTED`. Audit records changed field names only. |

The message-send operation description now documents the P0-3 gate: in a MANAGED workspace
with `dlp_enabled`, a `BLOCK` match returns `422 DLP_BLOCKED` before `seq` allocation and
rolls the send back; a `WARN` match records an event and delivers the message. E2EE is not
evaluated because the server has no plaintext.

`frontend/src/api/schema.d.ts` was regenerated with `npm run api:types` (openapi-typescript
7.13.0). `frontend/scripts/check-contract.mjs` was updated for the new counts/coverage and
P0-3 invariants (no content/IP fields in events/sessions, immutable mode, export bound,
DLP_BLOCKED documentation). That plus the generated types is the only frontend change; no UI
was built.

### 2. Database — V42 (`V42__workspace_security_dlp_audit_sessions.sql`)

- `workspace.security_settings` — one row per workspace (`workspace_id` PK), `require_2fa`,
  `session_timeout_minutes` (15..10080), `dlp_enabled`, `retention_days` (1..3650),
  `updated_at`, `updated_by`. `ENABLE` + `FORCE ROW LEVEL SECURITY` with the tenant policy
  `workspace_id = ops.current_workspace_id()`; `SELECT/INSERT/UPDATE` to `krug_app` (no
  DELETE). Existing workspaces are backfilled with defaults; new workspaces get the row in
  `WorkspaceRepositoryAdapter.save` (idempotent, so an onboarding upsert never overwrites
  values).
- `workspace.dlp_policies` — `id`, `workspace_id`, `name` (1..120), `action`
  (`WARN`/`BLOCK`), `pattern_type` (`KEYWORD`/`PATTERN`), `pattern` (1..200),
  `enabled`, `created_by`, `created_at`, `updated_at`. Unique `(workspace_id, lower(name))`,
  indexes `(workspace_id, created_at DESC, id DESC)` and partial `(workspace_id) WHERE
  enabled`; tenant FORCE RLS; `SELECT/INSERT/UPDATE/DELETE`.
- `workspace.dlp_events` — `id`, `workspace_id`, nullable `policy_id`
  (`ON DELETE SET NULL`), `rule_name` snapshot, `action`, nullable `actor_id`, nullable
  `chat_id`, `created_at`. **No message text/ciphertext/filename/email/IP column exists.**
  Three indexes for the page/action/policy filters; tenant FORCE RLS; append-only grants
  `SELECT, INSERT` only (no UPDATE/DELETE).
- `workspace.audit_page(...)` — read-only `SECURITY DEFINER` over the existing
  `audit.audit_events`. It explicitly filters `workspace_id` (the V6 RLS policy also allows
  the caller's own events from other tenants), re-checks ACTIVE OWNER/ADMIN membership and
  `p_caller_id = ops.current_user_id()`, and returns only the six contract columns. Metadata
  JSONB, hash-chain bytes, request id and actor email never leave the database.
- `workspace.security_member_subjects(workspace_id, caller_id)` — read-only
  `SECURITY DEFINER` returning only `user_id` + Keycloak subject of ACTIVE members, for an
  ACTIVE OWNER/ADMIN caller. Needed because `auth.user_identities` is self-scoped RLS.
- Both functions `REVOKE ALL FROM PUBLIC` and grant EXECUTE to `krug_app` only. The V42
  header includes the forward-only rollback plan (drop the two functions and the three new
  tables; audit rows, workspaces, memberships, chats and messages are untouched).

### 3. DLP evaluation and content-free events

- `DlpMatcher` (domain service) implements `KEYWORD` as `String.contains` and `PATTERN` as
  an iterative two-pointer `*` glob; **no `Pattern`, no recursion, no backtracking**. A
  regex-looking rule such as `(a+)+$` is ordinary text; a 200 000-character input returns in
  microseconds.
- `WorkspaceDlpEnforcementService` (implements the message-context `DlpGuardPort`) runs
  inside the message transaction after the permission/rate-limit checks and before `seq`
  allocation. Disabled DLP or a missing settings row is a no-op. A matching `BLOCK` rule
  writes a content-free event in a `REQUIRES_NEW` transaction (so it survives the rollback)
  and throws `422 DLP_BLOCKED`; a `WARN` rule appends the event to the message transaction
  and the message is delivered. Only ids, rule name, action and timestamps are written.
- The DLP event page is therefore backed by real decisions, not an empty table.

### 4. Workspace audit and export

- Every query goes through `workspace.audit_page`; the application guard and the SQL
  function both require OWNER/ADMIN. The page uses a workspace-bound opaque cursor with
  microsecond precision, so equal timestamps never duplicate or skip rows.
- Export is bounded to 10 000 rows, returns `X-Export-Rows`/`X-Export-Truncated`, and writes
  CSV with RFC 4180 quoting (quote only on comma, quote, CR/LF; embedded quote doubled) or
  the JSON object `{items, exported_rows, truncated}`. The JSON path lets clients consume a
  single bounded document; CSV is sent as `text/csv; charset=UTF-8` with a
  `Content-Disposition` attachment name.
- The export itself is audited (`workspace.audit.exported`) with format/returned/truncated
  counters only. No message body, E2EE envelope, file name, metadata JSONB, hash, request id
  or email is selectable through the page or export.

### 5. Workspace sessions

- `GET /workspaces/{id}/sessions` resolves ACTIVE members' Keycloak subjects through the V42
  function, calls `KeycloakAdminPort.listSessions` per member and flattens the result. The
  raw Keycloak payload (IP address, username, client map) never crosses the adapter;
  `device` is the client-derived label, and `current` is computed from the caller's `sid`.
- `DELETE .../sessions/{sessionId}` scans the workspace members, requires the id to belong to
  one of them, then revokes it through the Keycloak Admin API. Foreign and already-revoked
  ids are indistinguishable (`404`). The audit event stores the member id, not the session
  id/IP/username.
- `POST .../sessions/revoke-all` revokes individual caller sessions except the current
  `sid`, uses `logoutAllSessions` for other members, and returns counts. A Keycloak outage is
  `503 AUTH_UNAVAILABLE` with `Retry-After`; the operation is best-effort and may have
  revoked some sessions before the failure (documented).
- The member scan is bounded by the workspace member cap and the SQL function's `LIMIT 1000`.
  There is no local session cache, so revocation reflects Keycloak immediately.

### 6. Security settings

- `GET` lazily creates the row if it is missing and returns the five policy values.
- `PATCH` validates bounds, rejects an explicit `security_mode` with `422
  MODE_CHANGE_FORBIDDEN` (the V16 trigger remains the database backstop) and rejects
  `dlp_enabled=true` in E2EE. Same-value patches are idempotent and do not add a second
  audit event; audits store changed field names only.
- These values are the configuration surface. `require_2fa`, `session_timeout_minutes` and
  `retention_days` are stored for the security UI and downstream consumption; this slice does
  not add a new Keycloak MFA/session-timeout enforcement point or change the existing
  retention scheduler. `dlp_enabled` is enforced on MANAGED text sends (section 3).

## Tests and evidence

New tests: **41** (baseline 625 → **666** total; ArchUnit **10/10**).

| Test class | Tests | Coverage |
|---|---:|---|
| `WorkspaceSecurityIT` | 9 | DLP CRUD/validation/limits, content-free events + cursor, audit filters/cursor/cross-workspace isolation, CSV/JSON export + 10 000-row truncation, security defaults/patch/immutable mode, E2EE rejection, OWNER/ADMIN permissions/foreign workspace, dev session empty/revoke-all, DLP BLOCK/WARN enforcement |
| `WorkspaceSessionsIT` | 3 | Keycloak-backed member session list/current/order/pagination, member revoke + foreign 404 + non-manager 403, revoke-all spares caller current session, 503 outage for list/revoke/revoke-all, no IP/email/token leakage |
| `DlpPolicyRequestsTest` | 6 | literal regex-as-text, wildcard bound, control/length validation, action/type parsing |
| `DlpMatcherTest` | 4 | keyword/glob matching, adversarial `(a+)+$`, 200k-character linear scan |
| `WorkspaceDlpEnforcementServiceTest` | 4 | disabled/missing settings, WARN append, BLOCK independent append + `DLP_BLOCKED` |
| `WorkspaceSecurityCursorTest` | 5 | microsecond round-trip, scope/workspace binding, tampered/overlong keys |
| `WorkspaceAuditCsvTest` | 2 | RFC 4180 quoting and empty export |
| `WorkspaceSessionServiceTest` | 7 | current/sort/pagination, foreign 404, member subject/audit, outage 503, revoke-all spares current, malformed subject |
| `MigrationsIT` (new method) | +1 | V42 columns/RLS/indexes/grants/append-only events/SECURITY DEFINER functions |

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
mvn -o -Dmaven.repo.local=../.m2repo test
Tests run: 666, Failures: 0, Errors: 0, Skipped: 0
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

`npm run contract:check` — 109 operations, 148 contract schemas (86 paths), generated types
in sync. `npx tsc -p tsconfig.json --noEmit` is expected to stay green; the generated types
only add the new operations/schemas.

Environment note: the default `mvn` on this machine is JDK 26, where pre-existing Mockito /
Byte Buddy tests fail (`Java 26 (70) is not supported`). The suite was run with JDK 21
(`JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home`), the
project baseline. No test was disabled or skipped.

## Compatibility / rollout

- Additive contract and DB only. No existing endpoint, table, column, policy or grant is
  changed; `audit.audit_events` is reused read-only and stays append-only.
- DLP is disabled by default (`dlp_enabled=false`). Existing managed sends therefore keep
  their behaviour; when disabled, the only cost is one settings lookup per MANAGED text send.
  Enabling DLP is an explicit OWNER/ADMIN PATCH.
- The new tables have FORCE RLS with the existing tenant GUC; the two SECURITY DEFINER
  functions use the same DBA-provisioned split as V24/V25/V27 and re-check the caller, so RLS
  is not weakened.
- Rollback is in the V42 header: drop the two functions and the three new tables. DLP
  policies/events and security settings are lost; audit rows, workspaces, memberships, chats
  and messages are untouched.

## Out of scope / limitations

- DLP evaluates **managed text message sends only**. Attachments/file names, message edits,
  plugin payloads, call signalling and E2EE (no plaintext) are not evaluated.
- `require_2fa`, `session_timeout_minutes` and `retention_days` are stored policy values; this
  slice does not add Keycloak MFA enforcement, per-session timeout enforcement in the JWT
  path, or a new retention job. The existing retention scheduler is unchanged.
- The workspace session list makes one Keycloak Admin call per ACTIVE member (bounded by the
  workspace member cap / the function's `LIMIT 1000`). There is no local cache; a Keycloak
  outage is a clean `503`.
- Audit export is bounded to 10 000 rows and buffered as a byte array before the response; it
  is not chunk-streamed. Clients narrow `from`/`to` when `X-Export-Truncated` is true.
- Frontend `SecurityPage.tsx` was not changed in this slice; only `schema.d.ts` and the
  contract guard were updated. The UI still shows the existing disabled cards.

## Files

Created (backend):

- `backend/src/main/resources/db/migration/V42__workspace_security_dlp_audit_sessions.sql`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/DlpAction.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/DlpPatternType.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/DlpPolicy.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/DlpEvent.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceSecuritySettings.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceAuditEvent.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceMemberIdentity.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/service/DlpMatcher.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/DlpPolicyRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/DlpEventRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/WorkspaceAuditRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/WorkspaceSecuritySettingsRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/WorkspaceSessionDirectory.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/exception/InvalidWorkspaceSecurityCursorException.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/DlpPolicyRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/DlpEventRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/DlpEventAppenderAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceAuditRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceSecuritySettingsRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceSessionDirectoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/DlpPolicyView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/DlpEventView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/DlpEventPageView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceAuditView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceAuditPageView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceAuditExportView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/AuditExportFormat.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSessionView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSessionPageView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSessionRevokeAllView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSecurityView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSecurityContext.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceAuditFilter.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceSecurityCursor.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/command/CreateDlpPolicyCommand.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/command/UpdateDlpPolicyCommand.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/command/UpdateWorkspaceSecurityCommand.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/service/DlpPolicyRequests.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/service/WorkspaceSecurityRequests.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/service/WorkspaceSecurityActions.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/port/DlpEventAppender.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceSecurityGuard.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/DlpPolicyService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/DlpEventQueryService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceDlpEnforcementService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceAuditService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceSecuritySettingsService.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceSessionService.java`
- `backend/src/main/java/ru/krug/backend/message/application/port/DlpGuardPort.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/DlpPolicyResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/DlpPolicyListResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/CreateDlpPolicyRequest.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/UpdateDlpPolicyRequest.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/DlpEventResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/DlpEventPageResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceAuditEventResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceAuditPageResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceAuditExportResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceSessionResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceSessionPageResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceSessionRevokeAllResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceSecurityResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/UpdateWorkspaceSecurityRequest.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/mapper/WorkspaceSecurityApiMapper.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceDlpController.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceAuditController.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceSessionController.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceSecurityController.java`
- `backend/src/test/java/ru/krug/backend/integration/WorkspaceSecurityIT.java`
- `backend/src/test/java/ru/krug/backend/integration/WorkspaceSessionsIT.java`
- `backend/src/test/java/ru/krug/backend/unit/DlpPolicyRequestsTest.java`
- `backend/src/test/java/ru/krug/backend/unit/DlpMatcherTest.java`
- `backend/src/test/java/ru/krug/backend/unit/WorkspaceDlpEnforcementServiceTest.java`
- `backend/src/test/java/ru/krug/backend/unit/WorkspaceSecurityCursorTest.java`
- `backend/src/test/java/ru/krug/backend/unit/WorkspaceAuditCsvTest.java`
- `backend/src/test/java/ru/krug/backend/unit/WorkspaceSessionServiceTest.java`

Modified:

- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `frontend/scripts/check-contract.mjs` (counts/coverage + P0-3 invariants)
- `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
- `backend/src/main/java/ru/krug/backend/message/application/usecase/MessageSubmissionHandler.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceRepositoryAdapter.java`
- `backend/src/test/java/ru/krug/backend/integration/MigrationsIT.java`
- `backend/src/test/java/ru/krug/backend/support/KeycloakWireMock.java` (logout-all clears the fake session list, matching Keycloak)
