# E8 — Chat limits + first-run setup + admin UI

**Status:** DONE — backend 407 tests, frontend 645 tests; live setup/SMTP/admin/chat create verified. DIRECT/member picker is a follow-up.

> Реализация R-01…R-04 из `docs/SYSTEM-ANALYSIS.md` §17. Managed-only.

## Backend (E8-B)

1. V22: `auth.users.is_platform_admin`, `ops.system_settings` singleton (SMTP encrypted, business params, setup_completed_at); first user gets admin atomically.
2. Contract:
   - `GET /setup/status` public;
   - `GET/PATCH /admin/settings`, `POST /admin/settings/test-email`, `GET /admin/overview`;
   - `GET /me` + `is_platform_admin`;
   - `GET /workspaces/{id}/limits` + chat counters;
   - `POST /workspaces/{id}/chats` limit `409 CHAT_LIMIT_REACHED`.
3. Settings use cases, SMTP runtime adapter (DB settings override env), test email, encryption, audit.
4. Chat create limit in same transaction; group/direct rules; idempotency.
5. Tests: first admin, setup idempotency, SMTP test, limits per user/workspace, non-admin 403, RLS, no secrets in logs.
6. Full suite; ArchUnit.

## Frontend (E8-F)

1. `SetupWizard` on `/setup`; SMTP fields/test; business params; completion.
2. `/admin` overview/settings; guard by `me.is_platform_admin`; no E2EE content.
3. Chat creation dialog: `+`, type, name, members, limit usage; `CHAT_LIMIT_REACHED` state.
4. Workspace switcher: explicit selection, persist per device, reset state.
5. Tests: setup, admin guard, create chat, limit, workspace switch; axe.
6. `npm run check`.

## Acceptance

- Fresh install: first user admin, `/setup` mandatory, SMTP test, settings saved.
- Chat limit enforced server-side and reflected in UI.
- Workspace switch no data leak.
- `/admin` inaccessible to non-admin.
