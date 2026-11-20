# #91 — server-side 2FA policy and login-time enrollment

**Verdict: DONE.**

This slice makes two-factor authentication an installation policy rather than only a
per-user opt-in. The switch is `ops.system_settings.require_2fa` (V47, default `false`),
admin-managed through the existing `GET/PATCH /admin/settings`, and enforced by the backend
at login, at email verification and at refresh-token rotation. Accounts without an
authenticator get a `202` **ENROLL** challenge and no session; the new
`POST /auth/2fa/enroll/start|verify` endpoints create and confirm the authenticator and only
then return the Keycloak-backed session.

## 1. Contract

`contracts/openapi.yaml` is additive:

* `AdminSettings.require_2fa` (boolean, required) and `AdminSettingsPatch.require_2fa`
  (`boolean|null`, optional; wrong JSON types are `400 VALIDATION_FAILED`);
* `AuthTwoFactorChallenge.mode` (`TOTP|ENROLL`, required) — `TOTP` is the pre-#91 challenge,
  `ENROLL` means the account must create an authenticator first;
* new paths `POST /auth/2fa/enroll/start` (`TwoFactorSetup`) and
  `POST /auth/2fa/enroll/verify` (`AuthSession`), with `400/401/409/422/429/503` documented;
* `POST /auth/verify-email` now documents `202` (`AuthTwoFactorChallenge`) when the policy
  is on; `POST /auth/refresh` documents `403 TWO_FACTOR_REQUIRED`.

Final working-tree contract: **105 paths / 136 contract-check operations / 176 schemas**
(+2 paths, +2 operations, +2 schemas from this slice). The extra `/media/images` path/schema
comes from another concurrently developed slice in the shared workspace and is not part of
#91. `frontend/src/api/schema.d.ts` was regenerated with `npm run api:types`;
`npm run contract:check` passes. No admin UI or login UI was edited here (only the generated
types), per the task zone.

## 2. Server enforcement

### 2.1 Setting and admin surface

`V47__system_settings_require_2fa.sql` adds a plain `boolean not null default false`.
`SystemSettings`/`SystemSettingsView`/`SystemSettingsUpdateCommand`, the native settings
repository, `UpdateAdminSettingsService` and the admin mapper expose it. A PATCH accepts
`{"require_2fa": true}` and the response echoes `require_2fa`; the audit event records only
the field name (`require_2fa`), never a token/secret. The policy is read at authentication
time, not copied into a JWT, so the next login sees an admin change immediately.

### 2.2 Login matrix

`POST /auth/login` (and, additionally, `POST /auth/verify-email`):

| `require_2fa` | account has enabled TOTP | result |
|---|---|---|
| `false` | no | `200 AuthSession` (pre-#91 behaviour) |
| `false` | yes | `202` challenge `mode=TOTP`, methods `TOTP` + `RECOVERY_CODE` |
| `true` | yes | `202` challenge `mode=TOTP`, methods `TOTP` + `RECOVERY_CODE` |
| `true` | no | `202` challenge `mode=ENROLL`, methods `TOTP`, **no session/tokens** |

The Keycloak token pair continues to live only in the in-memory challenge (TTL 5 min,
single-use, 5 attempts). The challenge response, its `toString()` and the logs never contain
an access token, refresh token, secret or code.

### 2.3 Enrollment endpoints

`POST /auth/2fa/enroll/start` `{challenge_id}`

* accepts only an `ENROLL` challenge; an unknown/expired/consumed challenge is
  `401 TWO_FACTOR_CHALLENGE_INVALID`, a `TOTP` challenge on this endpoint is the same `401`;
* the password grant already proved the password, so no second password re-auth is asked;
* JIT-provisions the local user (the TOTP row has an FK to `auth.users`), creates a pending
  AES-256-GCM-encrypted secret and returns `{secret, otpauth_uri, qr_payload}`;
* a repeat call before confirmation returns the same pending secret instead of rotating it;
* an already-enabled authenticator is `409 TWO_FACTOR_ALREADY_ENABLED`;
* rate-limited through the existing per-user/per-IP 2FA limiter; no secret is logged.

`POST /auth/2fa/enroll/verify` `{challenge_id, code}`

* accepts only an `ENROLL` challenge; `TOTP` challenge → `401`;
* verifies the pending secret with RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), persists the
  accepted time step so it cannot be replayed, enables the authenticator, consumes the
  challenge and only then returns the held `AuthSession`;
* wrong code → `422 TWO_FACTOR_CODE_INVALID` and one attempt consumed; after the attempt
  budget the challenge is discarded (`401`); a consumed/expired challenge is `401`;
* missing pending setup → `409 TWO_FACTOR_NOT_SETUP`; a wrong code never enables the
  authenticator.

The existing `POST /auth/2fa/verify` rejects an `ENROLL` challenge with
`409 TWO_FACTOR_ENROLLMENT_REQUIRED`; the enrollment endpoints reject a `TOTP` challenge
with `401`. Modes are stored in the challenge record, so an endpoint cannot be used to skip
the other factor.

### 2.4 Refresh hardening

Every challenge completion marks the resulting refresh token in a bounded in-memory registry
(SHA-256 of the opaque token only). `POST /auth/refresh` first resolves whether the account
needs a second factor (installation policy **or** an enabled authenticator). If it does and
the presented refresh token was never minted by a completed challenge, refresh is
`403 TWO_FACTOR_REQUIRED`; otherwise Keycloak rotates the pair and the rotated token is
marked too. A password-only session therefore cannot be extended indefinitely.

### 2.5 Existing sessions when the admin turns the policy on

Existing **access tokens are not revoked**; they remain valid until their normal expiry.
A refresh token issued before the policy change was not minted by a 2FA-completed session,
so the next refresh is refused with `403 TWO_FACTOR_REQUIRED`, which forces a fresh login
that must complete TOTP or enrollment. This is the deliberate "enforce at the next login"
choice: no mass logout, no policy bypass through refresh. The same rule applies to email
verification (it can no longer mint a session while the policy is on).

## 3. Storage / RLS

`V47` is additive: no table, policy or grant is dropped or weakened. `ops.system_settings`
is an installation singleton without tenant RLS, as before; `auth.user_totp` and
`auth.user_recovery_codes` keep their self-scoped `FORCE ROW LEVEL SECURITY` and
`krug_app` grants. No plaintext secret, QR payload, TOTP code, recovery code, access token
or refresh token is written to PostgreSQL, the audit chain or logs. The enrollment flow
activates the same self-scoped tenant context as the pre-existing authenticator endpoints.

## 4. Tests

New scenarios:

| Class | Tests | Coverage |
|---|---|---|
| `TwoFactorPolicyIT` (new) | 7 | policy off keeps `200`; policy on + authenticator → `202 TOTP` + refresh; policy on without authenticator → `202 ENROLL`, start/verify, encrypted secret, no plaintext, audit metadata; attempt cap + mode confusion; ENROLL challenge rejected by `/auth/2fa/verify`; refresh refuses a password-only session then accepts the enrolled one; email verification cannot bypass the policy |
| `TwoFactorChallengeStoreTest` (new) | 4 | challenge mode, single-use, TTL expiry, attempt budget, no token in `toString()` |
| `AdminSettingsIT` | +1 (now 10) | `require_2fa` GET/PATCH, DB value, audit field-only metadata, invalid JSON type `400`, non-admin behaviour covered by the existing admin test |
| `MigrationsIT` | +1 (now 10) | `require_2fa` is `boolean NOT NULL DEFAULT false` and the singleton starts false |
| `TwoFactorIT` | 18 (unchanged) | pre-#91 TOTP setup/verify/recovery/login challenge/attempts/replay still pass with `mode` added |
| `ArchitectureTest` | 10 | layering (application does not depend on infrastructure/api, etc.) |

The in-memory stores keep the documented single-node limitation; expiry/attempts are
enforced on read and the challenge marker registry is bounded.

Actual runs (JDK 21, `mvn -o test`):

* focused: `TwoFactorPolicyIT` **7/7**, `TwoFactorIT` **18/18**, `AdminSettingsIT`
  **10/10**, `MigrationsIT` **10/10** — **45/45**, `BUILD SUCCESS`;
* full backend suite with the final V46 sticker migration included:
  **812 tests, 0 failures, 0 errors, 0 skipped** (includes `ArchitectureTest` 10/10),
  `BUILD SUCCESS`. #91 classes: `TwoFactorPolicyIT` 7/7, `TwoFactorIT` 18/18,
  `AdminSettingsIT` 10/10, `MigrationsIT` 10/10.

Shared-workspace note: V46 (another slice) deleted the cats pack. Two older regression
tests still referenced its deterministic ids (`StickerTestSupport.CATS_01` /
`CATS_PACK_ID`) and returned `404 STICKER_NOT_FOUND`; those references were switched to the
surviving `SOVA_02`/`SOVA_PACK_ID` (Krug owl pack) so the shared suite is green. No #91
production code touches stickers.

## 5. Acceptance

| Requirement | Status |
|---|---|
| `ops.system_settings.require_2fa` boolean, default false, V47 | ✅ |
| Admin GET/PATCH with validation | ✅ |
| Flag off → pre-#91 login behaviour | ✅ |
| Flag on + TOTP → existing `202` challenge | ✅ (`mode=TOTP`) |
| Flag on without TOTP → `202 ENROLL`, no session | ✅ |
| `POST /auth/2fa/enroll/start` → secret/otpauth | ✅ |
| `POST /auth/2fa/enroll/verify` → session | ✅ |
| Challenge single-use / 5 min / attempts | ✅ (store + IT) |
| Secret encrypted at rest, never logged/repeated by verify | ✅ (AES-GCM + IT) |
| Rate limit enrollment endpoints | ✅ existing 2FA limiter, per user/challenge + IP |
| No refresh bypass; refresh only from completed session | ✅ `TWO_FACTOR_REQUIRED` guard + test |
| Existing sessions: enforce next login, documented | ✅ access tokens kept; unverified refresh refused |
| Additive contract + generated types | ✅ 105/136/176 working tree |
| Full backend suite **759+**, ArchUnit | ✅ **812/812**, ArchUnit 10/10 |
| Report + counts | ✅ this file |

## 6. Residual limitations / follow-ups

* **Admin UI / enrollment UI wiring is outside this slice.** The API and generated types
  expose `require_2fa`, `mode=ENROLL` and the two new operations; a concurrently delivered
  frontend slice already binds `require_2fa` in `AdminSettingsForm` and consumes the
  enrollment endpoints. No frontend application component was edited here.
* The login challenge, completion-marker and pending-session stores are in-memory
  (single node). A restart drops pending challenges and completion markers: a 2FA user
  simply signs in again. Redis is the production follow-up, as documented for #82.
* Enrollment `start` can be called repeatedly for the same live challenge; it returns the
  same pending secret instead of rotating it. The secret is never returned after the
  challenge is consumed/expired.
* `POST /auth/verify-email` now returns `202` instead of `200` when the policy is on; this is
  an intentional backend enforcement point and is documented in the contract. A client that
  only understands the old `200` must be updated together with the policy rollout.
* The frontend `npx tsc` run currently reports unrelated errors from other in-flight
  workspace changes (i18n keys, image upload, QR typings); `schema.d.ts` itself was
  regenerated and `contract:check` passes.
