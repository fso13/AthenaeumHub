# Workspace security UI — DLP, audit/export, sessions and settings (P0-3 / #81)

**Verdict: DONE**

The P0-3 workspace security surface is implemented on top of the existing #81 backend
contract. The page now uses real API data only: DLP policy CRUD, the content-free DLP event
journal, the workspace audit page with a bounded CSV/JSON Blob export, member sessions with
single/all revocation, and the workspace security settings form. `npm run check` passes with
**1116 tests**.

## What changed

### 1. API, types and endpoints

All twelve #81 operations are wired through the existing `ApiClient` and the generated
contract types:

| Frontend method                                                                                                   | Contract operation                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `listWorkspaceDlpPolicies` / `createWorkspaceDlpPolicy` / `updateWorkspaceDlpPolicy` / `deleteWorkspaceDlpPolicy` | DLP policy CRUD                                                    |
| `listWorkspaceDlpEvents`                                                                                          | content-free event page (`policy_id`, `action`, `cursor`, `limit`) |
| `listWorkspaceAudit`                                                                                              | audit page (`action`, `actor_id`, `from`, `to`, cursor)            |
| `exportWorkspaceAudit`                                                                                            | bounded CSV/JSON export                                            |
| `listWorkspaceSessions` / `revokeWorkspaceSession` / `revokeAllWorkspaceSessions`                                 | member sessions                                                    |
| `getWorkspaceSecurity` / `updateWorkspaceSecurity`                                                                | security settings                                                  |

New P0-3 types are derived from `schema.d.ts` in `src/api/types.ts`; no field is hand-written.
`ApiClient` gained `getBlob()` so export bytes are never JSON-parsed or re-encoded. The export
method reads `X-Export-Rows`, `X-Export-Truncated` and a sanitized `Content-Disposition`
filename. `securityApi.test.ts` covers all query names, the `X-Device-Id` header, CSV/JSON
Blob downloads, the 503 `AUTH_UNAVAILABLE` mapping and filename sanitization.

### 2. SecurityPage

`src/components/pages/SecurityPage.tsx` keeps the existing page shell/design and renders:

- **Mode card.** MANAGED/E2EE copy, immutable-mode explanation and a permanently disabled
  "Изменить" control. No request can change `security_mode`; the UI never sends it.
- **Owner/admin gate.** The role comes from the active workspace / `/me` projection. In
  MANAGED mode OWNER/ADMIN loads DLP policies, DLP events, audit, sessions and settings. A
  MEMBER/GUEST gets the honest access notice and their own devices card; manager endpoints are
  never called (tested). The server remains the final 403 authority.
- **DLP policies.** List/create/edit/delete, WARN/BLOCK, KEYWORD/PATTERN, enabled state,
  field-level validation (name 1..120, pattern 1..200, control characters, ≤20 `*` for
  PATTERN), server errors (duplicate name, limit, E2EE), and a destructive delete confirmation.
  Copy explicitly states that patterns are literals, not regular expressions.
- **DLP events.** Cursor-paginated, exact policy/action filters, content-free columns (time,
  rule snapshot, action, actor id, chat id), empty vs no-match states. No message text,
  attachment, email or IP exists in the contract row and none is rendered.
- **Audit + export.** Exact action/actor/date filters with client validation (length, UUID,
  `from > to`), cursor pagination, and CSV/JSON export through the API Blob. The UI shows
  `X-Export-Rows` and an explicit truncation warning when `X-Export-Truncated` is true.
  Export notice is role-independent (OWNER/ADMIN page only).
- **Sessions.** Live Keycloak sessions grouped by `user_id` and device, a "Текущая сессия"
  chip, single revoke confirmation (with a special warning for the caller's own session) and
  revoke-all confirmation. Revoke-all reports `revoked_sessions`/`affected_users` and keeps
  the caller's session. Keycloak outages show `AUTH_UNAVAILABLE` with `Retry-After`; the
  confirm dialog stays open for retry.
- **Settings.** `require_2fa`, `session_timeout_minutes` (15..10080), `dlp_enabled`,
  `retention_days` (1..3650). Only changed fields go into PATCH, so same-value saves are
  idempotent. `dlp_enabled` is disabled/off in E2EE with an explanation. `security_mode` is
  never sent. Validation and server errors are shown inline.
- **Devices.** The existing self-service `GET /devices` card remains (no keys/fingerprints).

### 3. State and honesty

`src/security/securityStore.ts` owns the manager-scoped data: per-section generations,
opaque cursors, de-duplicated appended pages, filter-change invalidation of in-flight pages,
and server-response-only mutations. `reset()`/`close()` drop data on logout/role/workspace
changes. No optimistic policy/session/settings change is applied.

The UI refuses to invent data:

- empty/loading/error states are explicit; no placeholder rows or fake counters;
- E2EE skips DLP reads entirely and states that the server has no plaintext;
- all server-side policy values are rendered from `WorkspaceSecurity`, and the mode is
  immutable;
- raw server messages are not shown; errors map to translated copy with code/request id
  available on demand.

## MSW, tests and evidence

`src/mocks/db.ts` + `src/mocks/handlers.ts` now model the full #81 surface with
contract-shaped, content-free seeds: two DLP rules, DLP events, audit events, four Keycloak
sessions, security settings, request logs and injectable 503/409/500 failures. The mock guard
mirrors the real OWNER/ADMIN + workspace membership + `X-Device-Id` rules; E2EE returns an
empty DLP list and `422 DLP_E2EE_UNSUPPORTED` on mutations.

New tests: **24** (baseline 1092 → **1116** total):

| Suite                                    | Tests | Coverage                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/pages/SecurityPage.test.tsx` |    14 | OWNER load, MEMBER hidden/no-calls, DLP create/validate/duplicate/edit/delete + snapshots, event filters/pagination, audit filters/pagination/export Blob/truncation/errors, session grouping/current/revoke/revoke-all/503, settings save/validation/E2EE honesty, axe |
| `api/securityApi.test.ts`                |     6 | all twelve endpoints, query/header mapping, CRUD, session revoke-all, CSV/JSON Blob + headers, 503 `Retry-After`, filename sanitization                                                                                                                                 |
| `security/model.test.ts`                 |     4 | literal-not-regex validation/wildcards, session grouping order, minimal settings patch/bounds, date/UUID helpers                                                                                                                                                        |

Final evidence:

```
npm run check
Test Files  104 passed (104)
Tests       1116 passed (1116)
vite build  ✓ built
```

```
npm run contract:check
Contract check passed: 127 operations, 170 contract schemas, generated types in sync.
npm run security:check
Security check passed: 348 files, no XSS sinks, ... no token logs.
npm run session-writers:check
session-writers:check ok
```

The contract and `schema.d.ts` are unchanged by this slice (the generated types were already
regenerated by the backend task). The current checkout already includes later additive
contract work, hence the 127/170 totals; the P0-3 group is the twelve operations / fourteen
schemas described above. Only `frontend/**` was modified; `contracts/`, `backend/`, `docs/`,
`design/` and `schema` are untouched.

## Permissions / privacy checks

- The page never calls a manager endpoint for a non-manager; a late 403 is still mapped to
  the access copy, never treated as data.
- No IP address, Keycloak username, access/refresh/id token is rendered. `WorkspaceSession`
  has no such fields; `ErrorDetails` shows only code/request id/status.
- Export is a real Blob from `GET .../audit/export`; the browser download uses
  `URL.createObjectURL`, and the filename is sanitized to a basename.
- `security:check` passes (no XSS sinks, no token logs, no `localStorage`/`sessionStorage`
  additions).
- The destructive actions require explicit confirmation; the current session is labelled and
  the revoke-all dialog states that it is preserved.

## Limitations / out of scope

- DLP evaluates managed text sends only (attachments, edits and E2EE are not evaluated); this
  is the backend #81 boundary and is stated in the UI.
- `require_2fa`, `session_timeout_minutes` and `retention_days` are stored workspace policy
  values in this slice; the UI does not claim they are enforced by a new login/retention
  mechanism.
- The dev-auth (`VITE_AUTH_MODE=dev`) session has no workspace-role projection, so in that
  mock contour the page honestly shows the non-manager notice. Password/Auth BFF mode
  (the production contour and the D1 e2e contour) resolves OWNER/ADMIN from `/me`.
- The Playwright visual suite is not part of `npm run check`; a local attempt was blocked by
  a pre-existing demo-password drift in `e2e/d1-helpers.ts` (`Sova-demo-2026` vs the current
  `Sova-demo-2026` fixture), unrelated to this slice.

## Files

Created:

- `frontend/src/security/model.ts`
- `frontend/src/security/errors.ts`
- `frontend/src/security/securityStore.ts`
- `frontend/src/security/download.ts`
- `frontend/src/security/model.test.ts`
- `frontend/src/api/securityApi.test.ts`
- `frontend/src/components/security/SecurityUi.tsx`
- `frontend/src/components/security/DlpPoliciesCard.tsx`
- `frontend/src/components/security/DlpEventsCard.tsx`
- `frontend/src/components/security/AuditCard.tsx`
- `frontend/src/components/security/SessionsCard.tsx`
- `frontend/src/components/security/SecuritySettingsCard.tsx`
- `frontend/src/components/pages/SecurityPage.test.tsx`

Modified:

- `frontend/src/api/types.ts` (P0-3 contract type aliases)
- `frontend/src/api/endpoints.ts` (12 operations, export Blob result, filename sanitizer)
- `frontend/src/api/http.ts` (`getBlob`)
- `frontend/src/store/chatStore.ts` / `frontend/src/store/ChatProvider.tsx` (store wiring/hooks)
- `frontend/src/components/pages/SecurityPage.tsx` (real page)
- `frontend/src/i18n/ru.ts` (security copy)
- `frontend/src/styles/app.css` (security card/table/form styles)
- `frontend/src/mocks/db.ts` / `frontend/src/mocks/handlers.ts` (MSW #81 state/handlers)
- `frontend/src/components/Dashboard.test.tsx` (legacy Protection-page assertion)
- `frontend/scripts/check-contract.mjs` (Prettier formatting only)
