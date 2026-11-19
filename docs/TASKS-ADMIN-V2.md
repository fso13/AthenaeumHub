# E9 — Full admin (users/chats/storage) + UI/UX + LDAP docs

**Status:** DONE — backend 416 tests, frontend 661 tests; live admin lists/storage verified. LDAP guide in `docs/LDAP-KEYCLOAK.md`.

> R-05…R-07 из `docs/SYSTEM-ANALYSIS.md` §18. Managed-only.

## E9-B backend

- Contract: `GET /admin/users`, `GET /admin/chats`, `GET /admin/storage` (cursor, filters, totals).
- Aggregates only: no message text/E2EE envelopes/file bytes.
- Platform-admin guard; audit read; RLS-safe SECURITY DEFINER functions for cross-tenant aggregates.
- Tests: pagination/search/filter, counts, storage used/reserved/objects, non-admin 403, no content leak.

## E9-F frontend

- Admin sections: Overview / Users / Chats / Storage / Settings; search/filter/pagination, responsive tables/cards, skeleton/empty/error, axe.
- UI/UX pass: tokens, typography, spacing, dark/light, 390/768/1440, focus-visible, reduced motion; shell/composer/sidebar/auth/admin.
- Tests: RTL admin lists/filters/pagination, keyboard/axe, mobile snapshots; full check.

## LDAP/AD/FreeIPA

- `docs/LDAP-KEYCLOAK.md`: Keycloak User Federation, bind DN, mappers, TLS, registration policy, test, troubleshooting, AD/FreeIPA differences.
- Optional demo LDAP profile in deploy (follow-up, not required for docs).

## Acceptance

Admin sees users/chats/storage; UI modern/accessible; LDAP user can log in via Сова forms; no secrets/content leaks.


## E10 — Member directory + DIRECT chats

- `GET /workspaces/{id}/members` (active, cursor/search; user_id/display_name/role/joined_at).
- CreateChatDialog: GROUP/DIRECT, member picker, `peer_id`, idempotency, limits, empty/error.
- Tests: backend member search/RLS; frontend DIRECT create/member load; axe.

## E11 — Admin actions + audit view

- Backend: `POST /admin/users/{id}/suspend|activate`, `DELETE /admin/chats/{id}`, `GET /admin/audit`; Keycloak disable/enable, session revoke, soft-delete chat, audit.
- Contract additive; platform guard; no content/secrets.
- Frontend: actions with confirm dialogs, optimistic/refresh, error states; Audit tab; tests/axe.

## E12 — Workspace members management

- Backend: `POST /workspaces/{id}/members`, `PATCH/DELETE /workspaces/{id}/members/{userId}`; roles, limit, audit, SECURITY DEFINER lookup.
- Frontend: Members dialog (list/add/role/remove), owner/admin guard, errors, tests/axe.
- Unblocks F7B two-device E2EE (add second user to workspace).
