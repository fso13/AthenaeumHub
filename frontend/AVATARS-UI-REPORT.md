# Channel icons/avatars + workspace/user avatars — frontend report

**Verdict: DONE (frontend slice).** The backend/contract surface from
`CHAT-AVATAR-REPORT.md` and `PROFILE-WORKSPACE-REPORT.md` is consumed as-is.
All work is inside `frontend/**`; `backend/`, `contracts/`, `docs/`, `design/`
and `schema` were not modified. No new upload pipeline was added: every image is
an existing managed attachment selected from the file center / chat images.

Contract check stayed at **134 operations / 173 schemas** (`npm run contract:check`
passed, generated `src/api/schema.d.ts` in sync).

## 1. API layer

`src/api/types.ts`

- added `ChatAvatarRequest` (`{ file_id }`, generated from `ChatAvatarRequest`).

`src/api/endpoints.ts` (`ChatApi` + implementation)

| Method                                        | Operation                       | Notes                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getChatAvatarBlob(chatId)`                   | `GET /chats/{chatId}/avatar`    | `ApiClient.getBlob` follows the contract `302` to the 5-minute presigned URL; only bytes reach the caller.                                                                                                                  |
| `setChatAvatar(chatId, {file_id})`            | `POST /chats/{chatId}/avatar`   | returns the authoritative `Chat`; server owns 403/404/409/422/423.                                                                                                                                                          |
| `deleteChatAvatar(chatId)`                    | `DELETE /chats/{chatId}/avatar` | idempotent `204`; the attachment is not deleted.                                                                                                                                                                            |
| `getWorkspaceAvatarBlob(workspaceId, fileId)` | —                               | **contract/backend have no `GET /workspaces/{id}/avatar`**. The logo is an existing attachment (`logo_file_id`), so the helper resolves the regular `/attachments/{id}/download-url` presigned URL and follows it to bytes. |
| `getMyAvatarBlob()`                           | `GET /me/avatar`                | already existed; now reused by the global sidebar/header cache instead of only the profile dialog.                                                                                                                          |

`fetchPresignedBlob` re-wraps bytes cross-realm and maps non-2xx responses to
`ApiError`; no storage key/attachment id is written to the DOM.

## 2. Avatar cache (`src/avatars/avatarStore.ts`)

A small store (exposed as `ChatStore.avatars`, hooks `useAvatarsStore()` /
`useAvatarsState()`) owns the chat and workspace image cache:

- one entry per `chat:<id>` / `workspace:<id>`;
- one in-flight request per key (`ensureChat` / `ensureWorkspace` deduplicate the
  header + sidebar + details + settings callers);
- per-key request tokens: a late response from a replaced/removed avatar can
  never overwrite the new entry;
- `URL.createObjectURL` for authenticated blobs, revoked on change/invalidate;
  if the browser has no object-URL support the initials fallback is used;
- workspace logos fall back to the presigned URL when the blob read is not
  available (no CORS, transient failure);
- `404` is cached as `empty` (initials, not an error banner);
- `invalidateChat`, `invalidateWorkspace`, `reset()` on logout/workspace switch.

`ProfileWorkspaceStore` keeps the own `/me/avatar` preview cache; it is now
updated after `POST /me/avatar` (`loadMyAvatarPreview(true)`), cleared on
remove, and no longer revoked when the profile dialog closes (the sidebar row
shares it). It is still revoked on logout/workspace switch.

## 3. Applying avatars in the UI

| Surface             | Behaviour                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChatHeader`        | `Avatar` gets the chat blob URL; initials when the chat has no avatar, is DIRECT or 404s.                                                              |
| `ChatDetails`       | Same image on the 76 px profile avatar; DIRECT keeps peer initials.                                                                                    |
| `Sidebar` chat rows | Chat image, initials fallback; archived rows also resolve when the archive is opened.                                                                  |
| `SpaceRail`         | Workspace logo via the `logoUrls` prop resolved once by `AppShell`; initials fallback (and the component stays provider-free for its standalone test). |
| `WorkspaceSwitcher` | Each menu row uses the workspace logo; `logo_file_id: null` clears the cached entry.                                                                   |
| Sidebar user row    | `/me/avatar` object URL; initials fallback.                                                                                                            |
| `ProfileDialog`     | Hero + avatar card share the same `/me/avatar` cache; a successful set/remove refreshes it immediately.                                                |
| `Avatar`            | Any image load error flips back to initials (`onError`), so no broken images remain when a short-lived URL expires or a blob is revoked.               |

Workspace logos and chat avatars are invalidated from the store when the server
returns a changed `Chat` / `WorkspaceSummary`, so the rail/switcher/sidebar do
not keep a stale image after set/remove.

## 4. Chat settings — channel icon

`ChatSettingsDialog` main tab:

- a dedicated **«Иконка канала»** card with the current avatar preview
  (`Avatar`, initials fallback) and the current avatar/upload state;
- the picker is the **same candidate source as the cover**:
  `GET /files?chat_id=<id>&kind=IMAGE`, filtered to `CLEAN`/`SKIPPED` — no second
  file-center read and no upload endpoint;
- change/remove call `POST/DELETE /chats/{id}/avatar`; the returned `Chat`
  replaces the summary only after the server confirms it;
- loading / empty / retry states, per-action busy state and translated
  `403`, `404`, `409 ATTACHMENT_NOT_READY`, `422 CHAT_AVATAR_INVALID`,
  `423 ATTACHMENT_QUARANTINED` errors;
- DIRECT has no icon card; E2EE shows the honest disabled explanation;
- chat OWNER/ADMIN only (channel role loaded through the existing members read).

## 5. Create workspace

- `WorkspaceCreateDialog` is shared by the rail **“+”** and the switcher
  **“Создать пространство”**; both now open the same dialog
  (`WorkspaceSwitcher` gained `onCreateWorkspace`, `Sidebar`/`AppShell` wire it).
- `ChatStore.createWorkspace` now returns `boolean`; on success it activates the
  created workspace (the existing `activateWorkspace` path), so the rail, the
  switcher and the chat list select the new space.
- The dialog stays open on failure and shows `422` validation or the translated
  server/network message; the error is cleared the next time the dialog opens.
- The switcher create item is enabled when a handler is present (frontend-only
  change; no contract change).

## 6. MSW + tests

`src/mocks/db.ts` / `handlers.ts`:

- `chatAvatarRequests` log and `forceChatAvatarError` knob;
- `POST/DELETE/GET /chats/:chatId/avatar` with the same DIRECT/E2EE/role/image/
  scan gates as the cover, `avatar_file_id` in `Chat` responses, `GET` serving
  image bytes (the 302 is followed by `fetch`);
- existing workspace/me avatar handlers are reused by the new display tests.

New `src/components/AvatarsUi.test.tsx` — **8 tests**:

1. set icon from an existing chat image → header/sidebar show the blob, one
   deduped GET, remove → `DELETE` and initials return;
2. initials fallback when no icon is set;
3. translated `CHAT_AVATAR_INVALID` error keeps the old icon;
4. workspace logo in rail/switcher + own `/me/avatar` in the sidebar and profile
   (`GET /workspace avatar` via the documented presigned attachment flow);
5. own avatar refresh after `POST /me/avatar`;
6. axe audit with the settings avatar controls rendered (0 serious/critical);
7. rail “+” opens the dialog, creates a space and selects it;
8. switcher “Создать пространство” opens the same dialog and stays open on error.

`src/workspace/switcher.test.tsx` was updated for the now-enabled create item
(menu closes, dialog opens; Escape still returns focus to the trigger).

## 7. Checks

Full `npm run check` — **passed** (exit 0):

- `npm run lint` — 0 errors (2 pre-existing warnings, none in this slice);
- `npm run format:check` — all files formatted;
- `npm run contract:check` — **134 operations / 173 schemas**, generated types in
  sync;
- `npm run stickers:check`, `npm run security:check`,
  `npm run session-writers:check` — passed;
- `npm run test` — **1187 passing tests / 110 files**, including the 8 new
  avatar tests and the updated switcher suite (the run also contains the
  parallel plugin-package slice, which is green in the same run);
- `npm run build` — tsc + vite, passed (only the pre-existing chunk-size
  warning).

## 8. Files touched

Created:

- `src/avatars/avatarStore.ts`
- `src/components/AvatarsUi.test.tsx`
- `AVATARS-UI-REPORT.md` (this file)

Modified:

- `src/api/types.ts`, `src/api/endpoints.ts`
- `src/store/chatStore.ts`, `src/store/ChatProvider.tsx`
- `src/components/Avatar.tsx`, `ChatHeader.tsx`, `ChatDetails.tsx`,
  `Sidebar.tsx`, `SpaceRail.tsx`, `WorkspaceSwitcher.tsx`,
  `ChatSettingsDialog.tsx`, `ProfileDialog.tsx`, `AppShell.tsx`
- `src/domain/unread.ts` (`RailSpace.logo_file_id`)
- `src/profile/profileWorkspaceStore.ts`
- `src/mocks/db.ts`, `src/mocks/handlers.ts`
- `src/i18n/ru.ts`, `src/styles/app.css`
- `src/workspace/switcher.test.tsx`

## 9. Notes / residual

- **Workspace avatar read has no contract endpoint.** `POST/DELETE
/workspaces/{id}/avatar` exist, but there is no `GET`; the UI therefore reads
  the logo through the existing `logo_file_id` → presigned attachment download
  path (the same path the P0-4 settings panel already used). This is the only
  supported read surface and is covered by the new display test.
- No avatar for DIRECT channels and no avatar in E2EE channels, matching the
  backend rules; both keep the initials fallback.
- Avatars are not carried by realtime/outbox events (backend limitation); the
  list refreshes through the normal chat/settings responses.

**DONE**
