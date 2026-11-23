# #105 «Комнаты» — frontend report

**Status: DONE**

Scope: `frontend/**` only. Backend, contracts and generated types were not changed by this
task; `src/api/schema.d.ts` already contained the #105 room operations. The backend side is
documented in `backend/ROOMS-REPORT.md`.

Result: a new «Комнаты» workspace section (nav next to «Обзор»/«Файлы») with the room list,
create/rename/close, a 5 s list poll, a 5 s presence heartbeat, manifest «Вы в комнате» state,
an honest mesh video conference through the existing `CallController.startConference`, and the
shared `CallLayer` for incoming calls. No SFU, no E2EE, no Music Room code.

## 1. Contract surface used

Only the #105 operations (contract 135/167/214):

| Operation                                         | UI use                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `GET /workspaces/{workspaceId}/rooms`             | list + 5 s poll; server TTL-filters participants           |
| `POST /workspaces/{workspaceId}/rooms`            | create (name trimmed by the server, 1..120 code points)    |
| `PATCH /workspaces/{workspaceId}/rooms/{roomId}`  | rename the room and its backing channel                    |
| `DELETE /workspaces/{workspaceId}/rooms/{roomId}` | soft close (backing channel disappears from the chat list) |
| `POST /rooms/{roomId}/presence`                   | join + every 5 s heartbeat                                 |
| `DELETE /rooms/{roomId}/presence`                 | leave / page unmount (idempotent)                          |
| `GET /rooms/{roomId}`                             | client method added for completeness; page does not call   |

`Room.participants`, `participant_count` and `my_present` are rendered as returned by the
server. The page never derives participants from the member directory and never invents a
placeholder person.

## 2. Navigation and routing

- `router/views.ts`: `rooms` is a page view (`?view=rooms`), so the section is linkable and the
  browser back button keeps working.
- `components/Sidebar.tsx`: new nav row «Комнаты» (`nav.rooms`) with the video icon, placed
  between «Обзор» and «Файлы»; active state uses the shared `aria-current="page"` pattern.
- `components/AppShell.tsx`: renders `RoomsPage` for the view; `CallLayer` stays mounted once at
  the shell level, so incoming room calls ring from any surface.
- `i18n/ru.ts`: RU copy for the whole section (loading, empty, errors, call states, a11y labels).

## 3. Room list (`components/pages/RoomsPage.tsx`)

- Card: name, count label («1 участник» / «Участников: N» / «Пока никого нет»), participant
  avatars + names, «Вы в комнате» chip, «Создана вами» chip, active call chip.
- States: initial loading, empty list with a create entry point, full-page error + «Повторить»,
  background poll error banner that keeps the last rows, presence error, inline action errors.
- Create: header action toggles an inline labelled form; client-side trim/1..120 validation,
  server errors stay visible and a retry succeeds without a reload.
- Rename: inline form per card; validation + server error surfaces in the card.
- Close: inline confirmation («Закрыть комнату «…»?», hint that history is kept), then the row
  disappears; a forced 403 keeps the room and names the cause.
- Role-aware actions:
  - create — any ACTIVE workspace member (server guard);
  - rename — room creator, workspace OWNER or ADMIN;
  - close — room creator or workspace OWNER (ADMIN alone gets no close button).
  - The role comes from `activeWorkspace.role` (BFF session). Dev sessions have no role in
    `Session`, so the page performs one `GET /me` read and uses `me.workspaces[].role`.
- Mobile: two-column grid collapses to one column at 900 px; actions become full-width buttons
  at 560 px. All colors use existing Sova tokens, so dark/forced-colors behavior is inherited.

## 4. Join / leave / heartbeat

`rooms/roomsStore.ts`:

- `joinRoom(roomId)` — `POST presence`, then starts the 5 s heartbeat, then forces a list read
  and, if other participants are still present, starts the mesh conference.
- Heartbeat — every 5 s while `presenceRoomId` is set; one request in flight at a time. `409
ROOM_CLOSED`/`404` stop the heartbeat and refresh the list; other failures show a presence
  error but keep the TTL fallback on the server.
- `leaveRoom()` — stops the heartbeat, hangs up a call whose `chat_id` belongs to a room, calls
  `DELETE presence`, clears local presence and refreshes counts.
- `detach()` — page unmount: stops the heartbeat, ends a room call, fires the idempotent
  `DELETE presence` and clears local presence/call issue.
- The list poll runs only while the section is mounted; a hidden tab skips the read and catches
  up on the next visible tick.

## 5. Mesh call (no SFU claim)

- Join with other participants present → `CallController.startConference(room.chat_id,
presentOthers, true)` through a small bridge owned by `ChatStore`; `video` is always `true` for
  rooms.
- The bridge returns `busy` when another call is already active and `offline` when the realtime
  channel is not online; the card then shows «Звонок уже идёт в другом чате»/«Звонок недоступен:
  нет соединения реального времени» instead of pretending a call exists.
- Existing participants receive incoming `call.signal` conference offers through the unchanged
  global `CallLayer`; the suite covers accept → `getUserMedia` → answer for a room `chat_id`.
- The room page shows the call chip from `CallState` (`incoming`/`connecting`/`Идёт звонок`);
  media/camera/mute controls stay in `CallLayer`.
- No SDP/ICE/participant call state is stored on the server; nothing in the UI claims SFU,
  mixing, recording or call history.

## 6. Errors shown to the user

| Condition                                  | Copy                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `400`/`422`, blank or >120 name            | «Название должно содержать от 1 до 120 символов.»    |
| `403`                                      | «Недостаточно прав для этой комнаты.»                |
| `404`                                      | «Комната не найдена.»                                |
| `409 ROOM_CLOSED`                          | «Комната закрыта.»                                   |
| `409 CHAT_LIMIT_REACHED` (`details.scope`) | «Достигнут лимит чатов (пользователь/пространство)…» |
| `409 E2EE_GROUP_NOT_SUPPORTED`             | «В E2EE-пространстве комнаты недоступны.»            |
| network/timeout/5xx                        | shared `describeError` copy + retry where meaningful |

## 7. MSW and tests

Mock data (`src/mocks/db.ts`, `fixtures.ts`, `handlers.ts`):

- `db.rooms` records with an ephemeral `participants` table; every read applies the same 30 s
  TTL filter the backend uses, so the UI suite cannot pass with a "fake" peer.
- Handlers for list/create/get/patch/delete/presence with creator/OWNER(ADMIN) guards, `409
ROOM_CLOSED`, name validation, chat limits, `E2EE_GROUP_NOT_SUPPORTED`, a backing GROUP chat
  created/renamed/removed with the room, and request logs (`roomListRequests`, `roomRequests`,
  `roomPresenceRequests`). Injectable failures cover every call site.

`src/components/pages/RoomsPage.test.tsx` — 24 tests:

| Group        | Coverage                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| list         | server-only participants, count, design room does not leak other members, request log/device id                                 |
| polling      | 5 s interval re-reads the list                                                                                                  |
| create       | inline form, trimmed name, prepended server row, empty-name validation, `CHAT_LIMIT_REACHED` + retry                            |
| TTL          | a `last_seen_at` 31 s old peer is hidden; helper unit tests for fresh/expired/malformed timestamps                              |
| join         | `POST presence`, «Вы в комнате», count + own row, heartbeat posts every 5 s, honest offline-call note                           |
| leave        | idempotent `DELETE`, state restored, heartbeat stops (no further `join` posts)                                                  |
| call         | mesh offers to exactly the present peers (`conference:true`, `video:true`), leave stops tracks; incoming conference accept path |
| roles        | creator vs MEMBER (no actions), ADMIN (rename, no close)                                                                        |
| rename/close | PATCH/DELETE payloads, local + server errors, row removal, backing chat removal                                                 |
| errors/retry | initial load error + retry, background poll error + retry, `ROOM_CLOSED` join error                                             |
| navigation   | unmount stops the call and DELETEs presence; joining another room leaves the first one                                          |
| empty        | empty state with create entry point                                                                                             |
| a11y         | axe (serious/critical) on the list + create form                                                                                |

## 8. Full check

`npm run check`:

- lint — 0 errors (1 pre-existing warning in `src/e2ee/app/chatBridgeSupport.test.ts`);
- format — clean (two previously modified reports `AUDIO-METADATA-UI-REPORT.md`,
  `MUSIC-ROOM-REMOVAL-REPORT.md` were formatted by Prettier to let `format:check` pass; content
  unchanged);
- contract — `Contract check passed` (135/167/214, generated types in sync);
- stickers/security/session-writers — pass;
- tests — **140 files / 1397 tests passed** (baseline 139/1373; +24 room tests);
- build — `tsc --noEmit` + `vite build` pass.

## 9. Files

New:

- `src/rooms/roomsStore.ts` — list/poll, presence, heartbeat, actions, call bridge, TTL helper.
- `src/components/pages/RoomsPage.tsx` — the section UI.
- `src/components/pages/RoomsPage.test.tsx` — 24 tests.
- `ROOMS-UI-REPORT.md` — this report.

Changed:

- `src/api/types.ts` — `Room`, `RoomParticipant`, `RoomList`, create/update request aliases.
- `src/api/endpoints.ts` — 7 `ChatApi` room methods.
- `src/store/chatStore.ts` — `rooms` sub-store, `startRoomConference`, workspace binding, dispose.
- `src/store/ChatProvider.tsx` — `useRoomsStore`/`useRoomsState`.
- `src/router/views.ts`, `src/components/Sidebar.tsx`, `src/components/AppShell.tsx` — nav/section.
- `src/i18n/ru.ts`, `src/styles/app.css` — RU copy and Sova-token styles.
- `src/mocks/{db,fixtures,handlers}.ts` — rooms state, seed rows, handlers.

## 10. Limitations

- Presence is REST + TTL only (as contracted): another client can be up to ~5 s late seeing a
  join/leave, and an abandoned tab disappears after the 30 s TTL.
- `DELETE presence` on unmount is fire-and-forget; the server TTL is the fallback.
- No pagination: the list is the contract's hard cap of 200 active rooms, newest first.
- Rooms are MANAGED-only; an E2EE workspace gets `409 E2EE_GROUP_NOT_SUPPORTED` and the UI shows
  that code.
- A newcomer cannot join an already-running room conference: the backend keeps no call state,
  so a busy peer answers `busy`. The newcomer still sees the room and can call again once the
  other side is idle. This is an honest mesh/contract limitation, not an SFU claim.
- Closing a room is destructive in the UI (the room leaves the list); the backend keeps the
  messages and bytes, and the UI says so.
- No room covers/avatars/invite links — the contract has none.
- No Music Room code was used or reintroduced; no E2EE path was added.
