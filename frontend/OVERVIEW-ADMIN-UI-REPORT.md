# #84 — Overview, admin exports/sessions and translation-provider UI

**Verdict: DONE.**

Slice scope: `frontend/**` only. Backend #84 contract: `GET /workspaces/{id}/overview`,
`GET /admin/audit/export`, `GET/DELETE /admin/sessions…`,
`POST /admin/users/{id}/revoke-sessions`, `GET/PATCH /admin/plugins/translate`,
`POST /admin/plugins/translate/test` (contract tree: 117 paths / 144 operations / 191 schemas
at the time of this work; the shared tree also contains the concurrent #83 slice).

## 1. Workspace overview

`OverviewPage` now reads `GET /workspaces/{workspaceId}/overview` through a dedicated
`WorkspaceOverviewStore` (`src/workspace/overviewStore.ts`) wired into `ChatStore`:

- metrics: messages total/24 h, files total, members total/online, DLP events 24 h;
- storage: used/quota bytes with a meter and file used/reserved bytes;
- activity: `audit_recent` (≤ 5 content-free audit rows from the contract);
- team: total/online plus the existing member directory avatars;
- keeps the existing navigation (files, invite, quick chats, recent files, security) and
  the workspace/security-mode eyebrow.

Loading/error/retry are honest: a status line while loading, a `role="alert"` banner with
`HTTP <status> · <code>` and a retry button on failure, and the previously loaded snapshot is
kept during a failed refresh. A workspace switch resets the store and late responses from the
previous workspace are discarded.

The page never renders message bodies, E2EE envelopes, filenames from the overview response,
IPs or tokens. Recent-file tiles still come from already-loaded local state; the activity
preview is audit-only.

## 2. Admin audit export (CSV/JSON)

`AdminAuditSection` (`/admin?tab=audit`) gained two Blob downloads:

- `GET /admin/audit/export?format=csv|json` through `ApiClient.getBlob`; bytes are never
  re-encoded;
- `X-Export-Rows` / `X-Export-Truncated` are authoritative and shown in the UI
  (`Экспортировано строк: N`, plus a truncation warning);
- `Content-Disposition` is sanitized by the existing `contentDispositionFilename`;
- export uses the exact `action` filter of the audit page; changing the filter resets the
  export notice;
- export failures (e.g. 503) are shown without losing the loaded audit page and can be
  retried.

The export contains only the contract columns: `created_at, action, actor_id, actor_email,
target_type, target_id`. Metadata, hash-chain bytes and `request_id` are not part of the
response/type and are not rendered.

## 3. Platform-admin sessions

A new `AdminSessionsDialog` opens from the **Sessions** action of a user row in
`/admin?tab=users` and loads `GET /admin/sessions?user_id=…`:

- list: device label, created/last-seen timestamps, current-session badge; the contract has no
  IP, username, email or token fields and none are rendered;
- single revoke: `DELETE /admin/sessions/{id}` (idempotent `204`), row removed only after the
  server confirms; an honest retry re-sends the exact failed session id;
- revoke-all: two-step confirmation, `POST /admin/users/{id}/revoke-sessions`, then the
  server counters `revoked_sessions`/`affected_users`;
- opaque cursor pagination (cursor bound to the selected user);
- errors: `403` forbidden copy, `404 USER_NOT_FOUND` (“нет Keycloak identity”),
  `503 AUTH_UNAVAILABLE` with retry, network fallback. No optimistic mutation.

The dialog traps focus, closes on Escape/backdrop unless a request is in flight, and restores
focus to the trigger.

## 4. Translation-provider settings

A `AdminTranslationProvider` card now lives in `/admin?tab=plugins` and is linked from
`/admin?tab=settings` (“Настроить переводчик”):

- effective `{enabled, url}` from `GET /admin/plugins/translate`; explicit settings or the
  environment fallback are both displayed, with an explicit note that no secret/API-key field
  exists;
- `enabled` switch + absolute https URL, optional path; local validation mirrors the backend:
  no credentials/userinfo, query, fragment, whitespace/control characters, dot segments,
  port 0 or length > 2048;
- enabling without any effective URL is blocked client-side with the same
  `TRANSLATION_URL_REQUIRED` meaning; server 422 codes are surfaced honestly;
- save uses a partial `PATCH` (only changed fields; same-value repeat is idempotent);
- test connection uses `POST …/test` and shows only `OK`/`DISABLED`/`UNAVAILABLE` plus
  `latency_ms`; a disabled provider reports 0 ms without a network call;
- audit state: the card documents that `enabled`, `url_changed`, `status` and `latency` are
  audited and the URL itself is never logged.

## 5. MSW and tests

Mock additions (`src/mocks/db.ts`, `src/mocks/handlers.ts`):

- workspace overview projection + `override`/delay/error/request log;
- bounded admin audit export CSV (RFC 4180, six contract columns, LF) and JSON, with
  `X-Export-Rows`/`X-Export-Truncated`/`Content-Disposition`; injectable export error and a
  lowered cap for truncation tests;
- admin sessions seed and endpoints with user-bound cursor, 404/503 injection, idempotent
  revoke, revoke-all counters;
- translation settings/probe with https/credentials/query/fragment validation, 422 codes,
  update log, test status/latency and injectable errors.

Tests added (46 new cases):

| Suite                                | Tests | Coverage                                                                                                     |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------ |
| `OverviewPage.test.tsx`              |     5 | API values, loading, error+retry, navigation, axe                                                            |
| `AdminAuditExport.test.tsx`          |     3 | CSV Blob/RFC 4180/truncation, JSON contract, export error+retry                                              |
| `AdminSessions.test.tsx`             |     6 | list/current, single revoke, revoke-all counters, 503, 404, axe                                              |
| `AdminTranslation.test.tsx`          |     8 | effective URL, local validation, PATCH, server 422, test OK/DISABLED/UNAVAILABLE, settings→plugins link, axe |
| `adminDirectory.test.ts` (#84 block) |     7 | export counters/JSON fallback/error, session pages/revoke/revoke-all/retry                                   |
| `translation.test.ts`                |    14 | URL validation cases + dirty detection                                                                       |
| `overviewStore.test.ts`              |     3 | load/cache/error, stale workspace discard, reset                                                             |

## 6. Privacy / admin-only rules

- Every new endpoint call is authenticated and server-guarded by `PlatformAdminGuard`
  (and workspace membership for overview); the UI still surfaces `403` honestly.
- No token, IP, username, email (on sessions), message text, E2EE envelope, filename or
  provider body is present in any new type, mock response or rendered element.
- Translation settings contain no credential field; the URL is never logged by the client.

## 7. Verification

| Check                         | Result                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run lint`                | 0 errors, 2 pre-existing warnings                                                                   |
| `npm run format:check`        | pass                                                                                                |
| `npm run contract:check`      | pass (144 operations / 191 schemas, generated types in sync)                                        |
| `npm run build`               | pass (tsc + Vite)                                                                                   |
| #84 targeted suites (7 files) | **60 passed / 60**                                                                                  |
| Full `npm run test`           | **1266 passed / 1266** (122 test files)                                                             |
| `npm run check`               | **pass, exit 0** — lint + format + contract + stickers + security + session-writers + tests + build |

The baseline before this slice was 1204 tests; the final full suite reports 1266 passing
tests (> 1204 required). The concurrent #83 files/search/mentions tests and the #84 tests
share the same green tree at the time of the final `npm run check`.

## 8. Files

Created:

- `frontend/src/workspace/overviewStore.ts`
- `frontend/src/workspace/overviewStore.test.ts`
- `frontend/src/components/admin/AdminSessionsDialog.tsx`
- `frontend/src/components/admin/AdminSessions.test.tsx`
- `frontend/src/components/admin/AdminAuditExport.test.tsx`
- `frontend/src/components/admin/AdminTranslationProvider.tsx`
- `frontend/src/components/admin/AdminTranslation.test.tsx`
- `frontend/src/ops/translation.ts`
- `frontend/src/ops/translation.test.ts`
- `frontend/src/components/pages/OverviewPage.test.tsx`

Modified:

- `frontend/src/components/pages/OverviewPage.tsx`
- `frontend/src/components/pages/pageData.ts`
- `frontend/src/components/admin/AdminAuditSection.tsx`
- `frontend/src/components/admin/AdminUsersSection.tsx`
- `frontend/src/components/admin/AdminPluginsSection.tsx`
- `frontend/src/components/admin/AdminSettingsSection.tsx`
- `frontend/src/components/admin/AdminScreen.tsx`
- `frontend/src/api/endpoints.ts`
- `frontend/src/api/types.ts`
- `frontend/src/ops/adminDirectory.ts`
- `frontend/src/ops/adminDirectory.test.ts`
- `frontend/src/ops/store.ts`
- `frontend/src/store/chatStore.ts`
- `frontend/src/store/ChatProvider.tsx`
- `frontend/src/mocks/db.ts`
- `frontend/src/mocks/handlers.ts`
- `frontend/src/i18n/ru.ts`
- `frontend/src/styles/app.css`

## 9. Known limitations

- `members.online` is the backend's single-node presence signal (documented in
  `backend/OVERVIEW-ADMIN-REPORT.md`); the UI presents it as-is and clamps it in the local
  fallback only for the pre-overview team hint.
- `audit_recent` is empty for MEMBER/GUEST by contract; the page says so instead of inventing
  events.
- Admin session deletion depends on the Keycloak 26 realm-level endpoint; a `503` is shown
  with retry.
- The export cap notice names the contract cap (10 000); the mock can lower the cap for
  truncation tests, but production always uses 10 000.
