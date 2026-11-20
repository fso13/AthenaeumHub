# P0-4 / GitHub #82 — profile avatar, TOTP 2FA, workspace settings/logo/invites/permissions

**Verdict: DONE (backend + contract; UI wiring is outside this session's zone).**

This slice adds a self-service avatar, an RFC 6238 authenticator with a real login
challenge and hashed one-time recovery codes, workspace `name`/`description`/`logo_file_id`,
workspace invite links and the OWNER/ADMIN/MEMBER permission matrix. The migration is
`V43`, the contract change is additive, and no existing RLS policy or grant was weakened.

## 1. Contract / generated types

`contracts/openapi.yaml` is additive: **98 paths / 127 operations / 170 schemas**
(was 86 / 109 / 148 before this session; +12 paths, +18 operations, +22 schemas).
`frontend/src/api/schema.d.ts` was regenerated with `npm run api:types`
(openapi-typescript 7.13.0). `frontend/scripts/check-contract.mjs` was updated only for the
new exact counts/coverage and 18 new operation checks; no UI or store was changed.
`npm run contract:check` passes: *127 operations, 170 contract schemas, generated types in
sync*. `npx tsc -p tsconfig.json --noEmit` passes.

### Profile avatar

| Operation | Semantics |
|---|---|
| `POST /me/avatar` | `{file_id}` references an **existing** managed attachment; no new upload pipeline. Must be owned by the caller, an image, and pass the AV gate (`READY`/`BOUND` + `CLEAN`/`SKIPPED`). Foreign/missing → hidden `404`; non-image → `422 AVATAR_INVALID`; PENDING → `409 ATTACHMENT_NOT_READY`; infected → `423 ATTACHMENT_QUARANTINED`. Returns the updated `AuthUser`. |
| `DELETE /me/avatar` | Idempotent `204`; audit only when something changed. |
| `GET /me/avatar` | Authenticated `302` to a 5-minute presigned object URL; `404` when absent. |

`AuthUser.avatar_url` is a stable relative URL (`/api/v1/me/avatar`) and is `null` when no
avatar is set. The raw attachment id and storage key never appear in the profile payload.
DB: `auth.users.avatar_file_id` FK to `file.attachments(id) ON DELETE SET NULL` plus
`avatar_updated_at`.

### TOTP authenticator and login challenge

| Operation | Semantics |
|---|---|
| `GET /me/2fa` | `{enabled, enabled_at, recovery_codes_remaining}`; never the secret/codes. |
| `POST /me/2fa/setup` | Password re-auth required. Returns the 160-bit base64url secret, `otpauth://` URI and the same URI as `qr_payload` **once**. A repeat before confirmation rotates; after enable → `409 TWO_FACTOR_ALREADY_ENABLED`. |
| `POST /me/2fa/verify` | Confirms the pending secret with a 6-digit code. Wrong → `422 TWO_FACTOR_CODE_INVALID`; no setup → `409 TWO_FACTOR_NOT_SETUP`. An accepted TOTP time step is persisted. |
| `DELETE /me/2fa` | Requires the password **and** a valid TOTP/recovery code; wrong password → `403 REAUTH_FAILED`. Removes the secret and every recovery code. |
| `POST /me/2fa/recovery-codes` | Password re-auth; issues 10 fresh codes once, replaces the whole previous set. |
| `POST /auth/2fa/verify` | `{challenge_id, code}` completes the login challenge and returns `AuthSession`. Invalid/expired/single-use-consumed challenge → `401 TWO_FACTOR_CHALLENGE_INVALID`; wrong code → `422`; max attempts → challenge discarded. |

`POST /auth/login` now answers **`202 AuthTwoFactorChallenge`** instead of `200
AuthSession` when the local user has an enabled authenticator. The Keycloak token pair is
held server-side (in-memory challenge store, 5-minute TTL, 5 attempts, single-use) and is
not returned before the second factor is accepted. No-2FA accounts keep the existing `200`
flow.

Security decisions:

* the secret is returned only by `setup`; every later response/audit/log is redacted;
* at rest the secret is AES-256-GCM ciphertext (`auth.user_totp.secret_ciphertext`,
  `[version][nonce][ciphertext+tag]`, AAD bound to the user id); the cipher is
  domain-separated from the email-code cipher;
* recovery codes are 12 base32 chars in three groups (60 bits), stored only as
  `SHA-256("2fa-recovery|<user_id>|<normalized code>")`, marked used on consumption;
* TOTP verification uses RFC 6238 SHA-1 / 6 digits / 30 s, window ±1, and rejects a
  replayed time step;
* setup/disable/recovery regeneration require a password re-auth against Keycloak, bound to
  the caller's own `auth.user_identities` subject; a valid password for another account
  cannot unlock this one;
* all authenticator endpoints are rate-limited per user and per client IP
  (`krug.auth-bff.rate-limit.two-factor-*`);
* dev-only users have no Keycloak identity/password; there is nothing to verify, so the
  re-auth step is skipped only in that branch.

DB: `auth.user_totp` (self FORCE RLS, ciphertext/step/enabled_at only) and
`auth.user_recovery_codes` (self FORCE RLS, digest + used_at only).

### Workspace settings, logo, invites and permissions

| Operation | Semantics |
|---|---|
| `PATCH /workspaces/{id}` | Partial `name`/`description`/`logo_file_id`; `null`/blank description and `null` logo clear. `security_mode` is not accepted/immutable. Requires `manage_workspace`. |
| `POST /workspaces/{id}/avatar` | Set the logo from an existing CLEAN image in the same workspace. |
| `DELETE /workspaces/{id}/avatar` | Idempotent clear. |
| `GET/POST /workspaces/{id}/invites` | Metadata list / create. Create returns `token` + `accept_url` **once**; no email is sent. Role ceiling: OWNER can invite ADMIN/MEMBER/GUEST, ADMIN only MEMBER/GUEST; OWNER is never assignable. `max_uses` 1..1000 or unlimited, expiry 300..2 592 000 s (default 7 days). |
| `DELETE /workspaces/{id}/invites/{inviteId}` | Idempotent revoke (`204`); foreign/unknown → `404 WORKSPACE_INVITE_NOT_FOUND`. |
| `POST /workspace-invites/{token}/accept` | Joins the caller with the invite role. SECURITY DEFINER locks the invite row, enforces expiry/max_uses atomically, and answers an existing ACTIVE member idempotently (`already_member=true`, no use consumed). Revoked/expired/exhausted → `410` with distinct codes. Rate-limited per user. |
| `GET /workspaces/{id}/permissions` | Every ACTIVE member may read the effective matrix (OWNER/ADMIN/MEMBER × 6 rights). |
| `PATCH /workspaces/{id}/permissions` | Requires `manage_permissions`. OWNER cells are immutable (`422 OWNER_PERMISSIONS_IMMUTABLE`); an ADMIN may change only MEMBER cells, an OWNER may also change ADMIN cells (`403 PERMISSION_CHANGE_FORBIDDEN`). Entries are applied atomically. The matrix is enforced for workspace settings/logo and invites, not merely displayed. |

Defaults: OWNER all true; ADMIN all six true; MEMBER all false; GUEST no workspace-level
rights. DB: `workspace.workspaces.description` (≤500, plain text, control characters
rejected except `\n\r\t`) and `logo_file_id`; `workspace.role_permissions` (tenant FORCE
RLS); `workspace.invites` (tenant FORCE RLS, SHA-256 `token_hash` only); and the
`workspace.accept_invite(text, uuid)` SECURITY DEFINER function following the V24/V27/V40
pattern (owner can read the referenced FORCE-RLS tables; production DBAs provision the same
split; the function still re-checks `ops.current_user_id()`).

Audit metadata: `profile.avatar.updated`, `2fa.enabled`, `2fa.disabled`,
`2fa.recovery_codes.regenerated` (count only), `2fa.login.verified`,
`workspace.updated` (field names only), `workspace.invite.created/revoked/accepted`
(id/role/bounds only), `workspace.permissions.updated` (role/permission/allowed only).
No secret, code, recovery code, token, hash, email, name or description value enters the
audit chain or logs.

## 2. Migration / RLS

`backend/src/main/resources/db/migration/V43__profile_avatar_2fa_workspace_settings_invites_permissions.sql`:

* `auth.users.avatar_file_id` + `avatar_updated_at`;
* `auth.user_totp` — `ENABLE`/`FORCE ROW LEVEL SECURITY`, self policy;
* `auth.user_recovery_codes` — self policy, unused-code partial index;
* `workspace.workspaces.description`, `logo_file_id` + bounds/FK;
* `workspace.role_permissions` — tenant FORCE RLS, defaults backfilled for existing
  workspaces and seeded on creation;
* `workspace.invites` — tenant FORCE RLS, token-hash unique index;
* `workspace.accept_invite(...)` — `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO krug_app`.

No existing policy, grant, table or column was dropped or weakened.

## 3. Tests

New test classes and actual runs:

| Class | Tests |
|---|---|
| `ProfileWorkspace82IT` | **29** (avatar lifecycle/foreign/non-image/scan gates, workspace settings/logo/validation, permission matrix defaults + enforcement + invalid cells, invite lifecycle/role ceiling/expiry/exhaustion/revocation/RLS) |
| `TwoFactorIT` | **18** (setup/verify/status, password re-auth, recovery-code hashing/rotation, disable, login challenge/session, recovery login single-use, attempt exhaustion, replay rejection, no-2FA login, unauthenticated) |
| `TwoFactorDomainTest` | **8** (TOTP step matcher/window, recovery-code format/hash, secret redaction/step monotonicity, AES-GCM round-trip/AAD/tamper) |
| `WorkspaceSettingsDomainTest` | **12** (description bounds/clear, logo clear, permission defaults/parse, invite tokens, owner/admin role ceiling, invite status ordering) |

Full backend suite (JDK 21, project target):

```bash
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
  mvn -o -Dmaven.repo.local=.m2repo test
```

Result: **733 tests, 0 failures, 0 errors, 0 skipped** (includes `ArchitectureTest`
10/10). Previous suite size before this session was 666; this slice adds 67 tests. The
whole run used JDK 21 via `JAVA_HOME`, matching `pom.xml` target 21 and the Mockito
inline-mock constraint documented in `PROFILE-REPORT.md`.

Contract/frontend checks:

* `npm run api:types` — regenerated `frontend/src/api/schema.d.ts`.
* `npm run contract:check` — passed (127 operations, 170 schemas).
* `npx tsc -p tsconfig.json --noEmit` — passed.

## 4. Acceptance

| Requirement | Status |
|---|---|
| `POST/DELETE /me/avatar`, existing CLEAN image, `avatar_url` | ✅ (`GET /me/avatar` 302 added) |
| TOTP setup/verify/disable/recovery/login challenge | ✅ |
| Enforce 2FA at login when enabled | ✅ `202` challenge + `POST /auth/2fa/verify` |
| No plaintext TOTP secret at rest/logs/after setup | ✅ AES-GCM; redacted; tests |
| Recovery codes hashed one-time | ✅ SHA-256 bound to user, used_at |
| Password re-auth for setup/disable/recovery | ✅ Keycloak grant bound to own subject |
| Workspace `PATCH` name/description/logo | ✅ |
| `POST/DELETE /workspaces/{id}/avatar` | ✅ |
| Workspace invites create/list/revoke/accept, max_uses/expiry, no email | ✅ |
| Permission matrix OWNER/ADMIN/MEMBER, enforced | ✅ |
| DB V43 + RLS/grants not weakened | ✅ |
| Audit metadata only, no secrets/PII | ✅ |
| Full suite **666+**, ArchUnit | ✅ **733/733**, ArchUnit 10/10 |
| Additive contract + generated schema | ✅ 98/127/170 |

## 5. Residual limitations / follow-ups

* **UI wiring is outside this session's zone.** `ProfileDialog`/`SettingsPage` still show
  2FA as unavailable and do not render a `202` login challenge or avatar URL; only
  `frontend/src/api/schema.d.ts` was regenerated. The backend/contract are ready for that
  follow-up.
* The login challenge store is in-memory (single node, like the existing pending-session
  store). A restart or another node loses pending challenges; the user signs in again.
  Redis/multi-node storage is a production follow-up.
* Dev-only users (no Keycloak identity link) skip password re-auth because they have no
  password. Keycloak-authenticated users always require it.
* Avatar/logo resolution uses the existing `file-resolve` worker role for an id-only
  lookup, then re-activates the caller's tenant GUC before any write. The same narrow role
  pattern is used by the existing file download resolver.
* No background cleanup job for expired invites/2FA challenges; expired links are enforced
  on accept and challenge entries are swept lazily/TTL-bounded.
* `frontend/scripts/check-contract.mjs` was touched only for the contract count/coverage
  guard (same precedent as the P0-3 report); no application frontend code changed.
