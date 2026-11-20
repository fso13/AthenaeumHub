# P0-4 / #82 — profile avatar, TOTP 2FA login challenge, workspace settings/invites/permissions (frontend)

**Verdict: DONE (frontend UI + MSW + tests).** The backend/contract slice is consumed as-is;
`backend/`, `contracts/`, `docs/`, `design/` and `schema` were not modified.

Contract check: **98 paths / 127 operations / 170 schemas**, generated
`src/api/schema.d.ts` in sync (`npm run contract:check` passed). No contract change was
needed; `frontend/scripts/check-contract.mjs` already listed the 18 new operations.

## 1. API / types / endpoints

- `src/api/types.ts`: added contract aliases for `AvatarUpdate`, `ProfileAvatar`,
  `TwoFactorStatus|Setup|VerifyRequest|DisableRequest|RecoveryCodes`,
  `AuthTwoFactorChallenge`, `WorkspaceUpdate`, `WorkspaceAvatarRequest`,
  `WorkspaceInvite*`, `WorkspacePermissionMatrix|Entry|Update` and the six
  `WorkspacePermissionKey` values.
- `src/api/endpoints.ts`: new methods
  - avatar: `setMyAvatar(fileId)`, `removeMyAvatar()`, `getMyAvatarBlob()`;
  - 2FA: `getMyTwoFactor`, `setupMyTwoFactor(password)`, `verifyMyTwoFactor(code)`,
    `disableMyTwoFactor({password, code})`, `regenerateMyRecoveryCodes(password)`;
  - workspace: `updateWorkspace`, `setWorkspaceAvatar`, `deleteWorkspaceAvatar`,
    `list/create/revokeWorkspaceInvite`, `acceptWorkspaceInvite`,
    `get/updateWorkspacePermissions`.
- `src/api/http.ts`: `DELETE` now accepts an optional JSON body (required by
  `DELETE /me/2fa`); every other deletion stays bodyless.
- `src/api/authApi.ts`: `POST /auth/login` now returns a discriminated result —
  `200` → `{kind:'session'}`, `202` → `{kind:'challenge'}` — plus
  `verifyTwoFactor({challenge_id, code})`.

## 2. Profile dialog (`ProfileDialog` + `profile/`)

- **Avatar** (`components/ImageFilePicker`, profile avatar card):
  - chooses an existing image from `GET /files?kind=IMAGE` (only `CLEAN`/`SKIPPED`);
  - `POST/DELETE /me/avatar`; the `AuthUser` response replaces the store row, `204`
    only clears `avatar_url`;
  - the current avatar is previewed via the authenticated `GET /me/avatar` Blob
    (object URL), with initials fallback when a browser/jsdom cannot create one;
  - no upload pipeline, no attachment id/storage key in the DOM.
- **TOTP 2FA** (`components/profile/TwoFactorCard`):
  - status card from `GET /me/2fa` (`Включена/Выключена`, `enabled_at`, remaining codes);
  - setup requires the account password (re-auth), then shows the **secret and
    otpauth URI with copy buttons exactly once**, then verifies a 6-digit code;
  - after confirmation the 10 one-time recovery codes are issued and displayed for
    copying (or re-issued later through `POST /me/2fa/recovery-codes`);
  - disable requires password **and** a TOTP/recovery code in an inline confirm;
  - the secret/codes are kept only in the store's memory for the open flow and are
    dropped by `clearTwoFactorDraft()` on close/success. They are never written to
    storage, logs or the audit surface; the card never re-shows the secret.
  - 403/409/422/429/503 contract codes are translated; wrong password is surfaced as
    `Неверный пароль.` and re-prompts.

## 3. Login challenge

- `PasswordAuthProvider` handles `202 {challenge_id, expires_in, methods}`:
  no session/token is stored; the challenge lives in memory only
  (`PendingTwoFactorChallenge`), `POST /auth/2fa/verify` continues to `AuthSession`.
- `components/auth/TwoFactorChallengeScreen` (route `/2fa`, guarded by `AuthGate`):
  - TOTP / recovery-code mode switch driven by `methods`;
  - live challenge countdown, expired state, wrong-code (`422`), invalid/expired
    challenge (`401`), attempts limit (`429`) and network/503 states;
  - **resend** = request a fresh challenge by re-submitting the already verified
    password (the contract has no separate resend endpoint); 15 s local cooldown;
  - **back/cancel** returns to the credentials form; nothing is persisted, a reload
    falls back to login.
- `LoginScreen` still remembers only the email and navigates via the provider.

## 4. Workspace settings

`SettingsPage` → “Пространство” now renders `components/workspace/WorkspaceSettingsPanel`:

- **profile**: edit `name` (≤120) / `description` (≤500, plain text) with an
  incremental `PATCH /workspaces/{id}`; the returned `WorkspaceSummary` replaces the
  workspace list row, the active projection and the header name;
- **logo**: chosen from existing `IMAGE` files of the workspace via
  `POST/DELETE /workspaces/{id}/avatar`; current logo is previewed from a short-lived
  presigned URL (`download-url`);
- **invite links**: create (`role`, max uses 1..1000 or unlimited, 1/7/30 days),
  metadata list, revoke with confirmation, copy the one-time link. The raw token is
  shown once; the copied URL is the client-side `/workspace-invite/<token>`. **No email
  is ever sent; no email field exists in this flow.** OWNER may invite ADMIN/MEMBER/GUEST,
  ADMIN only MEMBER/GUEST; OWNER is never offered;
- **permissions matrix**: effective OWNER/ADMIN/MEMBER × 6 rights, OWNER cells always
  checked and disabled, ADMIN may edit only MEMBER cells, OWNER also ADMIN cells;
  only changed cells are sent as `entries`; success replaces the matrix with the
  server response. `403`, `422 OWNER_PERMISSIONS_IMMUTABLE` and validation are translated;
- **role gate**: the panel reads the effective matrix (not the role name) for
  `manage_workspace` / `manage_invites` / `manage_permissions`; while the matrix loads,
  write controls are disabled with an honest hint.
- `/workspace-invite/:token` accept page (`WorkspaceInviteAcceptPage`): preserves the
  route through login, explicit “Присоединиться”, explains `404/410` codes
  (expired/revoked/exhausted), idempotent `already_member`, then opens the joined
  workspace. The copyable link therefore works end-to-end.
- `SettingsPage` security card reports the real 2FA state instead of “unavailable”;
  the profile tab avatar button opens the profile modal.

## 5. MSW + tests

`src/mocks/db.ts` / `handlers.ts` / `fixtures.ts` now model:

- own avatar (`POST/DELETE/GET /me/avatar`, image/scan gates, `404/409/422/423`);
- TOTP status/setup/verify/recovery/disable with password re-auth, one-time secret and
  hashed-style recovery-code stand-in, plus a single-use login challenge (TTL 300 s,
  5 attempts, 202 login, recovery-code consumption);
- workspace `PATCH`, logo set/clear, invite create/list/revoke/accept (role ceiling,
  expiry/revocation), permission matrix defaults/update with OWNER immutability and
  ADMIN/MEMBER limits; injectable `force*Error` knobs for the UI error paths.

New suite `src/components/ProfileWorkspace82.test.tsx` — **14 tests**:

1. avatar set from an existing CLEAN image + remove;
2. only scan-approved images offered / empty state;
3. 2FA setup → one-time secret/otpauth → code verify → recovery codes → disable;
4. wrong password for setup (no secret leaked);
5. axe audit with the 2FA card rendered (serious/critical = 0);
6. `202` login challenge → wrong code → correct TOTP → session;
7. fresh challenge (“resend”) + cancel back to login;
8. recovery-code login consumes the code;
9. workspace name/description save + logo from files;
10. invite create/copy/revoke (no email);
11. OWNER immutable, OWNER edits ADMIN cells;
12. ADMIN edits only MEMBER cells;
13. MEMBER read-only role gate;
14. `/workspace-invite/<token>` accept after login.

Updated existing assertions in `src/components/Profile.test.tsx` (the old “2FA API is
missing” text is no longer true) and `src/api/authApi.test.ts` (login result union).

### Test evidence (full suite intentionally not re-run here)

- baseline before the slice: **1116 tests / 104 files passed**;
- new suite: **14/14 passed**;
- impacted suites re-run: `Profile`, `authFlow`, `authApi`, `Dashboard`, `ChatInvites`,
  `WorkspaceMembers` — **78/78 passed** (92 incl. the new suite);
- expected full total: **1130** (1116 + 14). The delegating parent runs the final
  `npm run check`.
- `npx tsc -p tsconfig.json --noEmit` — clean;
- `npm run contract:check` — passed (127 operations, 170 schemas, types in sync);
- `npm run security:check` — passed (355 files; no XSS sinks, no token logs);
- `npm run session-writers:check` — passed;
- `npm run format:check` — passed;
- `eslint .` — **0 errors** (2 pre-existing warnings outside this slice).

## 6. Security invariants

- raw TOTP secret / otpauth URI are displayed only from the one-time setup response and
  are never persisted, logged, copied into a store snapshot on close, or re-shown after
  verification;
- recovery codes are one-time display in memory only; the server side stores hashes;
- the login challenge id is memory-only; tokens stay server-side until the second factor
  is accepted;
- passwords are sent only to the re-auth/verify payloads, are kept in component/provider
  refs for the duration of the flow and are never persisted;
- no email invitation path, no email field in workspace invites, and no “sent email”
  wording; the copy hint explicitly says the inviter must share the link;
- avatar/logo choices go through the documented CLEAN/SKIPPED gate; foreign or
  non-image files are rejected by the server and translated by the UI.

## 7. Known limitations / follow-ups

- No QR image is rendered (no QR dependency was added); the setup shows the secret and
  the `otpauth://` URI, both copyable, which is the contract-required one-time payload.
- “Resend” for the login challenge re-submits the already verified password because the
  contract has no dedicated resend operation; it rotates `challenge_id` and resets TTL.
- The profile avatar preview uses an authenticated Blob fetch of `GET /me/avatar`
  (the contract `302` is followed by `fetch`). If a deployment’s presigned object
  endpoint disallows cross-origin `fetch`, the UI falls back to initials; the stable
  `<img src="/api/v1/me/avatar">` path cannot attach the Bearer token.
- The MSW `GET /me/avatar` returns image bytes with `200` rather than a `302`; the client
  contract observed by `fetch` (a Blob) is identical.
- Workspace logo display uses the existing `attachments/{id}/download-url` file flow;
  no logo URL was added to the contract.
- The mock’s invite acceptance for the seeded workspace reports `already_member=true`
  because the demo user already owns it; distinct join semantics are covered by the
  server contract (`WorkspaceInviteAcceptance`) and the `404/410` paths are wired.
