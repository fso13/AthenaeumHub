# Frontend #100/#101 — email invites + DLP scope/size UI

**Verdict: DONE**

Contract: **133 paths / 213 schemas** (`npm run contract:check` — 162 operations, 213
schemas, generated types in sync). Backend `#100`/`#101` reports were the source of truth;
this slice touches only `frontend/**`. No E2EE changes.

## 1. DLP UI (#101)

### Types and draft model (`src/api/types.ts`, `src/security/model.ts`)

- `DlpScope = DlpPolicy['scope']` (`ALL | TEXT | ATTACHMENT | PLUGIN`) exported alongside
  `DlpPolicy`.
- `DlpPolicyDraft` now carries `scope` (default `ALL`), `maxFileSizeBytes` as an input
  string, and `originalMaxFileSizeBytes` so the edit form knows whether the stored
  threshold can change.
- Validation mirrors the server envelope:
  - scope must be one of the four contract literals;
  - `max_file_size_bytes` is an integer 1 B … 10 GiB (`10 737 418 240`);
  - a size threshold is rejected for `TEXT`/`PLUGIN`
    (`security.validation.maxFileSizeScope`);
  - an existing (non-clearable) threshold blocks switching to `TEXT`/`PLUGIN`
    (`security.validation.scopeLocked`) instead of letting the server answer an
    avoidable `400`.
- `toCreateDlpBody` always sends `scope`; sends `max_file_size_bytes` only when the input
  is non-empty and the surface supports it.
- `toUpdateDlpBody` follows the additive PATCH contract: an empty size field **omits**
  `max_file_size_bytes`, which the server defines as “keep the stored value” (a threshold
  cannot be cleared through this contract).

### DLP card (`src/components/security/DlpPoliciesCard.tsx`)

- Added a **surface select** (ALL/TEXT/ATTACHMENT/PLUGIN) and an attachment **size
  threshold** input with field-level validation, byte formatting and hints.
- Editing shows the stored threshold; when a rule already has one, the `TEXT`/`PLUGIN`
  options are disabled with an explicit explanation (no fake “cleared” state).
- The table gained `Поверхность` and `Порог размера` columns; a threshold is shown only
  for `ALL`/`ATTACHMENT` rules and formatted (`0 Б … 10 ГБ`).
- Added a **coverage notice** listing the real enforcement points — message text/edit,
  attachment metadata on upload/bind/rename, and plugin poll/task/translate — and stating
  that E2EE is not evaluated and that the client does not filter content. The UI never
  claims local enforcement; every decision is the server’s.
- E2EE workspaces keep the honest “DLP unavailable” card; no DLP calls are made there.

### Security settings notices (`src/components/security/SecuritySettingsCard.tsx`)

Added an enforcement block that explains:

- DLP is enforced by the server on the listed surfaces;
- the session timeout is enforced at refresh (an already-issued access token lives until
  its normal expiry, so the IdP TTL must stay below the minimum timeout);
- retention is a daily server job; the UI does not delete data itself and only exposes
  the configured `retention_days`.

### Error handling (`src/domain/errors.ts`)

`422 DLP_BLOCKED` is mapped to a translated, policy-specific error that uses only
`details.surface` (`TEXT`/`ATTACHMENT`/`PLUGIN`). The policy name/pattern/payload are
never echoed; `canRestoreText` is true only for the text surface.

## 2. Email invites (#100)

### API client

- `previewWorkspaceInvite(token)` implements anonymous `GET /workspace-invites/{token}`.
  The request is sent with `auth: false` (no bearer/device headers) and returns only
  `WorkspaceInvitePreview` (`workspace_name`, `workspace_slug`, `role`, `email_bound`,
  `expires_at`).
- `ApiClient.get` gained an optional `{ auth?: boolean }` argument (additive) so public
  reads can bypass ambient credentials.

### Workspace settings (`src/components/workspace/WorkspaceSettingsPanel.tsx`)

- Optional **email** field: empty keeps the existing multi-use link flow; non-empty
  creates a single-use email invite, forces `max_uses: 1`, disables the uses input and
  labels the action “Отправить приглашение”.
- Local email validation (shape/254) happens before the request; the server remains the
  authority for normalization, role ceiling, rate limits and SMTP failures.
- The created panel says “Письмо отправлено” and names the bound address, while still
  showing the one-time link. The invite list shows `Email: …`, “Одноразовое · письмо
  отправлено” and the same address in the revoke confirmation.

### Anonymous preview + accept (`src/components/WorkspaceInviteAcceptPage.tsx`)

- `/workspace-invite/{token}` first renders the **public preview** (anonymous, no auth
  guard) with workspace name/slug, role, expiry and an `email_bound` notice.
- Anonymous visitors get honest sign-in / create-account actions. The token is carried
  through `/login` and `/register` in the `invite_token` query parameter (URL/flow only;
  never storage).
- After authentication the same page exposes “Присоединиться” and surfaces distinct
  `404`/`410 EXPIRED|REVOKED|EXHAUSTED`/`403 EMAIL_MISMATCH`/`429` errors. An
  `EMAIL_MISMATCH` answer is shown as “приглашение привязано к другому email”; the mock
  keeps the invite unconsumed.
- The page never renders the raw token; it only appears in the address bar.

### Auth flow (`src/components/auth/AuthGate.tsx`, `RegisterScreen.tsx`,

`src/auth/PasswordAuthProvider.tsx`, `src/router/inviteRoutes.ts`)

- Route parsing extracted to `src/router/inviteRoutes.ts`
  (`parseWorkspaceInviteRoute`, `readInviteToken`, `withInviteToken`,
  `workspaceInvitePath`, `INVITE_TOKEN_RE`).
- `AuthGate` renders the anonymous preview for the invite route and returns an
  authenticated user to the invite page when `invite_token` is present.
- `RegisterScreen` shows a “registration by invitation” notice and passes the token to
  `auth.register`; `PasswordAuthProvider.register` sends `invite_token` once to
  `POST /auth/register` and preserves the URL token across `/verify` and `/2fa` so the
  post-verification claim is followed by an idempotent accept screen.
- No token is written to `localStorage`/`sessionStorage`, logged, or put into the auth
  session; only the URL and the register request carry it.

## 3. Mocks / seeds

- DLP seed rows carry `scope: 'ALL'` and `max_file_size_bytes: null`.
- DLP create/update handlers accept `scope` and `max_file_size_bytes`, default scope to
  `ALL`, validate the enum, integer bounds 1 B…10 GiB, attachment-only applicability and
  PATCH “absent = keep” semantics.
- Invite create accepts optional `email`, normalizes lower-case, forces `max_uses=1` and
  rejects an explicit different value with `400 VALIDATION_FAILED`.
- New anonymous `GET /workspace-invites/:token` handler returns display metadata only and
  answers `404`/`410` for unknown/revoked/expired/exhausted. Accept enforces
  `WORKSPACE_INVITE_EMAIL_MISMATCH` (case-insensitive). The shared status guard keeps
  EXPIRED/REVOKED/EXHAUSTED as distinct `410` codes.
- The mock register handler records `invite_token` with the pending verification (the real
  backend stores only its SHA-256 hash) and never returns it.

## 4. Tests and checks

New/updated coverage:

| Suite                                                   | Coverage                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/security/model.test.ts`                            | scope/size draft mapping, bounds, TEXT/PLUGIN rejection, locked threshold, create/update bodies                                                    |
| `src/api/securityApi.test.ts`                           | create with `ATTACHMENT` + size; PATCH scope/size                                                                                                  |
| `src/components/pages/SecurityPage.test.tsx`            | ATTACHMENT + 5 MB create, table display, locked TEXT option, coverage notice; existing suite still green                                           |
| `src/components/WorkspaceInviteEmail100.test.tsx` (new) | anonymous preview without raw token/storage, email mismatch, revoked preview, register carries `invite_token`, email invite create/list, axe audit |
| `src/components/ProfileWorkspace82.test.tsx`            | login round-trip now starts from the anonymous preview, then accepts                                                                               |
| `src/domain/errors.test.ts`                             | `DLP_BLOCKED` surface mapping, no rule disclosure, text-restore only for `TEXT`                                                                    |

Commands and results (JDK-independent):

```
cd frontend
npm run contract:check   # 162 operations, 213 contract schemas, generated types in sync
npm run security:check   # 432 files, no XSS sinks, no token logs/storage
npm run session-writers:check
npm run stickers:check
npm run check            # green: lint + format + contract + stickers + security
                         #        + session-writers + 1367 tests + tsc/vite build
# test phase: 142 files, 1367 tests, 0 failures (115.3 s under a loaded host)
# build: 585 modules transformed, vite build succeeded
```

## 5. Contract limitations kept visible in the UI

- `max_file_size_bytes` cannot be **cleared** by the additive PATCH contract (absent =
  keep). The edit form keeps the stored value and disables `TEXT`/`PLUGIN` for rules that
  have one, instead of claiming a clear succeeded.
- The anonymous preview intentionally exposes no invited address; only `email_bound` is
  shown, so an email invite is accepted/rejected by the server without account
  enumeration.
- Email delivery happens inside the invite transaction on the backend. A `503
SMTP_UNAVAILABLE` is surfaced as an honest create error; the UI does not show a
  success state.
- No client-side DLP filtering is implemented or implied: the UI renders server coverage
  and the `422 DLP_BLOCKED` error only.

**Verdict: DONE**
