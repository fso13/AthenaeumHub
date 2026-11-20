# #84 — Workspace overview, admin exports/sessions and translation provider config

**Verdict: DONE.**

This slice adds a membership-scoped workspace overview, platform-admin audit export and
Keycloak session management, and an installation-level translation-provider configuration
that the translate plugin reads at runtime. The contract/DB changes are additive, every
read is bounded, and no endpoint exposes message text, E2EE envelopes, filenames, IP
addresses, tokens or provider content.

## 1. Contract

`contracts/openapi.yaml` is additive: **+7 paths / +8 operations / +8 schemas** for this
slice (the shared working tree also contains the concurrently developed #83
files/search/mentions slice; final tree counts at the time of this report are
117 paths / 151 operations / 191 schemas).

| Operation | Semantics |
|---|---|
| `GET /workspaces/{workspaceId}/overview` | Any ACTIVE member of an ACTIVE workspace. Counts/bytes only: members total/online, chats, messages total/24h, files total/used/reserved bytes, DLP events 24h, storage quota, up to 5 recent audit rows (OWNER/ADMIN only). Foreign/unknown workspace → `403`. |
| `GET /admin/audit/export?format=csv\|json` | platform_admin. Same columns as the audit page, hard cap 10 000 rows, `X-Export-Rows` / `X-Export-Truncated`. CSV is RFC 4180 (`text/csv; charset=UTF-8`); JSON is `AdminAuditExport`. Export is audited with counters only. |
| `GET /admin/sessions?user_id=&cursor=&limit=` | platform_admin. Live Keycloak sessions of the selected local user; `last_seen_at DESC, id DESC`; cursor bound to `user_id`; no IP/username/email/token. Unknown/no-identity user → `404 USER_NOT_FOUND`; outage → `503 AUTH_UNAVAILABLE`. |
| `DELETE /admin/sessions/{sessionId}` | platform_admin. Idempotent revoke by session id (Keycloak 26 realm-level endpoint); `204`; outage → `503`. |
| `POST /admin/users/{userId}/revoke-sessions` | platform_admin. Revokes every Keycloak session of the user; returns only `{revoked_sessions, affected_users}`; `404`/`503` documented. |
| `GET /admin/plugins/translate` | platform_admin. Effective `{enabled, url}` (explicit setting, otherwise environment fallback). |
| `PATCH /admin/plugins/translate` | Partial `{enabled?, url?}`; https-only absolute URL with optional path, no credentials/query/fragment (`422 TRANSLATION_URL_INVALID`); enabling without any URL → `422 TRANSLATION_URL_REQUIRED`; no-op repeat is idempotent. |
| `POST /admin/plugins/translate/test` | platform_admin. One bounded probe; returns only `status` (`OK`/`DISABLED`/`UNAVAILABLE`) and `latency_ms`; no provider content. |

New component schemas: `WorkspaceOverview`, `AdminAuditExport`, `AdminSession`,
`AdminSessionPage`, `AdminSessionRevokeAll`, `TranslationProviderSettings`,
`TranslationProviderUpdate`, `TranslationProviderTest`.

`frontend/src/api/schema.d.ts` was regenerated with `npm run api:types`.
`frontend/scripts/check-contract.mjs` now covers the new operations and asserts the
content-free/bounded invariants (audit_recent ≤ 5, no metadata/hashes, no IP/username/token
on sessions, URL-only translation config, status enum, bounded export). `npm run
contract:check` passes.

## 2. Workspace overview

`GET /api/v1/workspaces/{workspaceId}/overview`

- The service activates the tenant GUC, requires an ACTIVE workspace + ACTIVE membership
  (any role), then calls the V49 `workspace.overview_stats` `SECURITY DEFINER` aggregate.
  The SQL function re-checks the same membership and the current-user GUC, so a bypass
  still receives no row.
- Aggregates are index-backed and bounded:
  - `members.total` — ACTIVE memberships joined to ACTIVE users;
  - `chats` — non-deleted chats (`ix_chats_ws_active`);
  - `messages.total` — `sum(GREATEST(chat_counters.next_seq - 1, 0))`, the same bounded
    aggregate the admin chat list uses, never a full timeline scan;
  - `messages.last_24h` — real non-deleted rows in the last 24 h through the new
    `(workspace_id, created_at DESC)` index on the partitioned timeline;
  - `files.total` — READY/BOUND, non-deleted attachments; `used_bytes`/`reserved_bytes`
    from `file.workspace_usage`; `storage.quota_bytes` from `file.workspace_limits` with the
    documented 1 TiB default for a workspace that has not used files yet;
  - `dlp.events_last_24h` — content-free DLP decision rows.
- `members.online` is the distinct-user count of live WS connections in the workspace. It
  is a single-node in-process presence signal, not persisted and clamped to `members.total`.
- `audit_recent` is produced by the existing `workspace.audit_page` with `limit=5`; only
  OWNER/ADMIN callers receive rows, regular members get an empty array. It contains action,
  actor, target and time only — no metadata, hash, request id or email.
- No message body, ciphertext, filename, E2EE envelope, email, IP or token exists in the
  response DTO.

## 3. Platform audit export

`GET /api/v1/admin/audit/export`

- The platform-admin guard runs first; the read uses the new
  `ops.admin_audit_export(action, limit, caller_id)` `SECURITY DEFINER` function, which
  re-checks `is_platform_admin` and `p_caller_id = ops.current_user_id()` in SQL.
- Only the seven `AdminAuditEvent` columns are returned; metadata JSONB, hash-chain bytes
  and request ids never leave the database. The exchange is ordered
  `created_at DESC, id DESC` and backed by the new global `ix_audit_events_created`.
- Hard cap 10 000 rows (one probe row detects truncation), `X-Export-Rows` /
  `X-Export-Truncated` headers. CSV is RFC 4180 (quote only comma/quote/CR/LF, embedded
  quote doubled); JSON is the bounded `AdminAuditExport`.
- Exporting is itself audited as `admin.audit.exported` with `format`, `returned` and
  `truncated` only.

## 4. Platform-admin sessions

- `GET /admin/sessions?user_id=` resolves the local user id to its opaque Keycloak subject
  through `ops.admin_user_subject` (which re-checks the platform-admin caller). The raw
  Keycloak payload (IP address, username, client map) never crosses the port.
- Rows expose `id`, local `user_id`, client-derived `device`, `created_at`, `last_seen_at`
  and `current` (caller's `sid` when the selected user is the caller). Cursor is
  base64url, microsecond-precision and bound to `user_id`; it cannot be replayed for
  another user.
- `DELETE /admin/sessions/{id}` uses the Keycloak 26 realm-level
  `DELETE /admin/realms/{realm}/sessions/{id}`; a missing/already-revoked session is
  idempotent `204`. `POST /admin/users/{id}/revoke-sessions` counts the live sessions,
  logs out all of them and returns counts only.
- Every read/mutation is audited with ids/counters only. A Keycloak outage maps to
  `503 AUTH_UNAVAILABLE` with `Retry-After`.

## 5. Translation provider configuration

- V49 adds `ops.plugin_translation_settings` (singleton id=1): `enabled boolean`, `url text`
  (≤ 2048), `updated_at`, `updated_by`. There is **no credential/API-key column**.
- `TranslationSettingsService.current()` is read on every translate call: an explicit row
  wins; a saved `enabled=false` disables the provider even when the environment URL is set;
  when no row exists the historical `KRUG_PLUGINS_TRANSLATE_URL` is the fallback. This
  keeps existing installations working while making the admin switch authoritative.
- `PATCH` validates `https` only, rejects credentials/userinfo, query, fragment, control
  characters and dot-segment paths, and requires a URL when enabling without a fallback.
  Same-value repeats do not create a second audit event. Audit contains `enabled` and
  `url_changed`, never the URL.
- `HttpTranslationProvider` now reads the effective settings at runtime and implements the
  health probe. The probe sends a constant text, discards the provider answer, is bounded by
  the existing connect/read timeouts and response-size cap, and never logs the source,
  translation, URL or provider body.
- Health returns `OK`/`DISABLED`/`UNAVAILABLE` plus measured latency (≤ 60 s); disabled
  makes no network call. The endpoint never returns content.

## 6. Database — V49

`V49__overview_admin_exports_sessions_translation.sql` is additive:

- indexes `chat.ix_chats_ws_active`, `message.ix_messages_ws_created` (partitioned parent
  index) and `audit.ix_audit_events_created`;
- `workspace.overview_stats(uuid, uuid, timestamptz)` — read-only SECURITY DEFINER,
  membership re-check, counts/bytes only;
- `ops.admin_audit_export(text, integer, uuid)` — bounded (≤ 10001) platform audit read,
  platform-admin re-check, contract columns only;
- `ops.admin_user_subject(uuid, uuid)` — platform-admin-only local id → opaque Keycloak
  subject lookup;
- `ops.plugin_translation_settings` with SELECT/INSERT/UPDATE to `krug_app` and no secret
  column.

All functions `REVOKE ALL FROM PUBLIC` and grant EXECUTE only to `krug_app`. No existing
table, policy or grant is weakened; `audit.audit_events` stays append-only.

## 7. Tests and evidence

New tests: **52** test methods/invocations (including parameterized URL cases).
ArchUnit remains 10/10.

| Test class | Tests | Coverage |
|---|---:|---|
| `WorkspaceOverviewIT` | 4 | aggregate sums vs DB, files/usage/quota, DLP 24h, manager audit preview, member empty preview, empty workspace, foreign/unknown 403, content/filename absence |
| `AdminAuditExportIT` | 3 | CSV header + RFC 4180 rows, JSON contract, export audit counters, 10 000-row truncation, invalid/missing format, non-admin 403 |
| `AdminSessionsIT` | 3 | subject lookup, current flag, cursor binding, no PII, idempotent delete, revoke-all counts, 404/403, 503 outage for list/delete/revoke-all |
| `TranslationProviderAdminIT` | 3 | defaults, https/credentials/query/fragment validation, required URL, persist/read, health status/latency with no content, no-op audit, disable, non-admin 403 |
| `TranslationEnvFallbackIT` | 1 | environment fallback until an explicit row exists; explicit disable wins; re-enable uses fallback |
| `TranslationProviderUrlTest` | 17 | valid https/path/port, blank clear, non-https/relative/credentials/query/fragment/dot-segment/control/overlong rejection |
| `TranslationSettingsServiceTest` | 9 | row/env precedence, explicit disable, fallback, required URL, save+audit, no-op, invalid URL |
| `AdminAuditCsvTest` | 3 | seven-column header, RFC 4180 quoting, empty fields not `null` |
| `AdminSessionCursorTest` | 4 | microsecond round-trip, user binding, malformed, overlong/control session id |
| `WorkspaceOverviewServiceTest` | 4 | manager preview, member empty, online clamp, 403/no stats read |
| `MigrationsIT` (new method) | +1 | V49 indexes, SECURITY DEFINER functions/grants, translation table columns and grants |

Evidence (JDK 21, Testcontainers PostgreSQL 16):

```
# targeted #84 suites
Tests run: 4,  Failures: 0, Errors: 0  (WorkspaceOverviewIT)
Tests run: 3,  Failures: 0, Errors: 0  (AdminAuditExportIT)
Tests run: 3,  Failures: 0, Errors: 0  (AdminSessionsIT)
Tests run: 4,  Failures: 0, Errors: 0  (TranslationProviderAdminIT + TranslationEnvFallbackIT)
Tests run: 47, Failures: 0, Errors: 0  (new unit tests + ArchitectureTest)
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0
```

Full suite (isolated copy of the shared workspace, JDK 21, Testcontainers PostgreSQL 16):

```
# unrestricted suite
Tests run: 900, Failures: 1, Errors: 3, Skipped: 0
# excluding the four concurrently developed #83 classes
# (MentionsIT, MentionsE2eeIT, MessageSearchIT, WorkspaceFilesIT)
Tests run: 887, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
```

The four non-green classes in the unrestricted run belong to the concurrent #83
files/search/mentions slice (fixture updates to the immutable `security_mode`, an E2EE
message fixture violating `ck_messages_e2ee_no_managed_body`, mention fixture result
sizes and a file rename/delete expectation). No #84 test fails in either run;
`npm run contract:check` passes.

## 8. Limitations

- `members.online` is a single-node in-process WS presence signal. A multi-node deployment
  would need a shared presence store; the value is explicitly documented as best-effort.
- `messages.total` is the same cumulative allocated-sequence aggregate used by the admin
  chat list (it includes deleted messages); `messages.last_24h` is the real non-deleted row
  count. Bodies and E2EE envelopes are never read.
- Admin session deletion relies on the Keycloak 26 realm-level
  `DELETE /admin/realms/{realm}/sessions/{id}` endpoint. Older Keycloak versions would need
  owner resolution; the 404-safe adapter keeps the operation idempotent.
- Admin audit export is buffered as a byte array, not streamed; it is hard-capped at
  10 000 rows.
- Translation config intentionally has no API key/secret. Providers needing a credential
  are out of scope; credentials/userinfo/query/fragment are rejected. The health probe
  sends a constant text (`ping`) and discards the answer.
- Admin sessions are addressed by local `user_id`; a local user without a Keycloak identity
  is `404 USER_NOT_FOUND` (dev users have no IdP sessions).

## 9. Files

Created (backend):

- `backend/src/main/resources/db/migration/V49__overview_admin_exports_sessions_translation.sql`
- `backend/src/main/java/ru/krug/backend/workspace/domain/model/WorkspaceOverviewStats.java`
- `backend/src/main/java/ru/krug/backend/workspace/domain/repository/WorkspaceOverviewRepository.java`
- `backend/src/main/java/ru/krug/backend/workspace/infrastructure/persistence/WorkspaceOverviewRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/port/WorkspacePresencePort.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/model/WorkspaceOverviewView.java`
- `backend/src/main/java/ru/krug/backend/workspace/application/usecase/WorkspaceOverviewService.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/dto/WorkspaceOverviewResponse.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/mapper/WorkspaceOverviewApiMapper.java`
- `backend/src/main/java/ru/krug/backend/workspace/api/WorkspaceOverviewController.java`
- `backend/src/main/java/ru/krug/backend/realtime/infrastructure/adapter/RealtimeWorkspacePresenceAdapter.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminAuditExportView.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminExportFormat.java`
- `backend/src/main/java/ru/krug/backend/ops/application/usecase/ExportAdminAuditService.java`
- `backend/src/main/java/ru/krug/backend/ops/api/dto/AdminAuditExportResponse.java`
- `backend/src/main/java/ru/krug/backend/ops/api/mapper/AdminAuditExportMapper.java`
- `backend/src/main/java/ru/krug/backend/ops/domain/repository/AdminSessionDirectory.java`
- `backend/src/main/java/ru/krug/backend/ops/infrastructure/persistence/AdminSessionDirectoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminSessionView.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminSessionPageView.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminSessionRevokeAllView.java`
- `backend/src/main/java/ru/krug/backend/ops/application/model/AdminSessionCursor.java`
- `backend/src/main/java/ru/krug/backend/ops/application/usecase/AdminSessionService.java`
- `backend/src/main/java/ru/krug/backend/ops/api/dto/AdminSessionResponse.java`
- `backend/src/main/java/ru/krug/backend/ops/api/dto/AdminSessionPageResponse.java`
- `backend/src/main/java/ru/krug/backend/ops/api/dto/AdminSessionRevokeAllResponse.java`
- `backend/src/main/java/ru/krug/backend/ops/api/mapper/AdminSessionApiMapper.java`
- `backend/src/main/java/ru/krug/backend/ops/api/AdminSessionController.java`
- `backend/src/main/java/ru/krug/backend/plugin/domain/model/TranslationSettings.java`
- `backend/src/main/java/ru/krug/backend/plugin/domain/repository/TranslationSettingsRepository.java`
- `backend/src/main/java/ru/krug/backend/plugin/infrastructure/persistence/TranslationSettingsRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/port/TranslationEnvPort.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/port/TranslationProbePort.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/model/EffectiveTranslationSettings.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/model/TranslationSettingsView.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/model/TranslationHealthView.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/service/TranslationProviderUrl.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/usecase/TranslationSettingsService.java`
- `backend/src/main/java/ru/krug/backend/plugin/application/usecase/TranslationHealthService.java`
- `backend/src/main/java/ru/krug/backend/plugin/infrastructure/config/TranslationEnvAdapter.java`
- `backend/src/main/java/ru/krug/backend/plugin/api/dto/TranslationProviderSettingsResponse.java`
- `backend/src/main/java/ru/krug/backend/plugin/api/dto/TranslationProviderTestResponse.java`
- `backend/src/main/java/ru/krug/backend/plugin/api/dto/UpdateTranslationProviderRequest.java`
- `backend/src/main/java/ru/krug/backend/plugin/api/mapper/PluginTranslationApiMapper.java`
- `backend/src/main/java/ru/krug/backend/plugin/api/PluginTranslationAdminController.java`
- `backend/src/test/java/ru/krug/backend/integration/WorkspaceOverviewIT.java`
- `backend/src/test/java/ru/krug/backend/integration/AdminAuditExportIT.java`
- `backend/src/test/java/ru/krug/backend/integration/AdminSessionsIT.java`
- `backend/src/test/java/ru/krug/backend/integration/TranslationProviderAdminIT.java`
- `backend/src/test/java/ru/krug/backend/integration/TranslationEnvFallbackIT.java`
- `backend/src/test/java/ru/krug/backend/unit/TranslationProviderUrlTest.java`
- `backend/src/test/java/ru/krug/backend/unit/TranslationSettingsServiceTest.java`
- `backend/src/test/java/ru/krug/backend/unit/AdminAuditCsvTest.java`
- `backend/src/test/java/ru/krug/backend/unit/AdminSessionCursorTest.java`
- `backend/src/test/java/ru/krug/backend/unit/WorkspaceOverviewServiceTest.java`

Modified:

- `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
- `backend/src/main/java/ru/krug/backend/realtime/infrastructure/ws/InMemoryRealtimeHub.java`
- `backend/src/main/java/ru/krug/backend/auth/application/port/KeycloakAdminPort.java`
- `backend/src/main/java/ru/krug/backend/auth/infrastructure/keycloak/KeycloakAdminAdapter.java`
- `backend/src/main/java/ru/krug/backend/auth/infrastructure/keycloak/KeycloakEndpoints.java`
- `backend/src/main/java/ru/krug/backend/ops/api/AdminAuditController.java`
- `backend/src/main/java/ru/krug/backend/ops/api/AdminUserActionsController.java`
- `backend/src/main/java/ru/krug/backend/ops/domain/repository/AdminActionRepository.java`
- `backend/src/main/java/ru/krug/backend/ops/infrastructure/persistence/AdminActionRepositoryAdapter.java`
- `backend/src/main/java/ru/krug/backend/plugin/infrastructure/translation/HttpTranslationProvider.java`
- `backend/src/test/java/ru/krug/backend/support/KeycloakWireMock.java` (realm-level session delete)
- `backend/src/test/java/ru/krug/backend/integration/MigrationsIT.java` (V49 assertions)
- `contracts/openapi.yaml`
- `frontend/src/api/schema.d.ts` (generated)
- `frontend/scripts/check-contract.mjs`
