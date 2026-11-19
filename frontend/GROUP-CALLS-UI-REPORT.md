# #77 GROUP calls UI (mesh, no SFU) — frontend report

**Status: DONE**

Scope: `frontend/**` only. Backend, contracts, docs, design and schema were not
modified by this task. The backend/contract side of the same feature is documented in
`backend/GROUP-CALLS-REPORT.md` and `contracts/ws-protocol.md` §9.5; this report describes the
frontend that consumes it.

Result: GROUP channels now start a participant-picked mesh audio/video conference with one
local stream and one `RTCPeerConnection` per selected member; DIRECT keeps its original 1:1
flow and payload shape. No SFU, no TURN, no call persistence.

## 1. Wire protocol used

GROUP frames are the existing `call.signal` with two additive fields (§9.5):

```json
{
  "call_id": "same-for-every-leg",
  "kind": "offer|answer|ice|hangup|busy",
  "video": true,
  "conference": true,
  "recipients": ["peer-user-uuid"],
  "sdp": "…",
  "candidate": { "candidate": "…", "sdpMid": "0", "sdpMLineIndex": 0 }
}
```

- One `call_id` for the whole conference; offers go to each selected peer separately
  (`recipients:[peerId]`), answers/ICE/hangup/busy go back to the peer/caller they belong to.
- Incoming frames are routed by the envelope `from_user_id`; the parser now preserves
  `conference` and `recipients` and the optional `from_user_id` of `call.unavailable`.
- DIRECT sends **no** `conference`/`recipients` keys, so the original §9.1 payload and the
  existing 1:1 tests stay byte-identical.
- GROUP `call.unavailable` has no recipient id (§9.5.3); the controller attributes it to the
  FIFO of unanswered offers, removing one offline invitee without ending the mesh. Explicit
  `from_user_id` wins if a future server adds it.

## 2. Participant picker (`GroupCallPicker.tsx`)

- GROUP header audio/video buttons open the modal «Новый звонок» with the workspace ACTIVE
  directory, the caller excluded, checkboxes, a selected counter and **at least one** required
  participant; «Позвонить» stays disabled until one is checked.
- «Выбрать всех» selects/clears the whole loaded list; audio/video toggle is a segmented
  control; loading, empty, error + retry and "show more" states are covered.
- Modal a11y: `role="dialog"`, `aria-modal`, labelled/described, focus trap, initial focus,
  Escape/backdrop close, focus return to the trigger, 390 px-friendly full-height layout.
- The details footer call row opens the same picker for GROUP; DIRECT still starts 1:1
  immediately (header or details) with no modal.

## 3. Mesh engine (`CallController`)

- `startConference(chatId, peerIds, video)`: one `getUserMedia` stream, one PC per selected
  peer, one offer per peer, all sharing one `call_id`.
- Answer/ICE routing by `from_user_id`; remote candidates that arrive before the remote
  description are buffered **per peer** and flushed afterwards.
- Incoming conference: the first offer opens the incoming overlay and ringtone; additional
  callers with the same `call_id` are added to the same ringing dialog. `accept()` opens media
  once and answers every caller. `reject()` sends `hangup` to every caller without touching
  media.
- A `busy`/`hangup`/failed leg removes only that participant; the conference stays connected
  while at least one remote leg exists and ends (with an honest notice) at zero. Explicit
  `hangup()` cleans every peer connection, every remote stream and the shared local stream.
- `addParticipant(peerId)` / `removeParticipant(peerId)` support mesh membership changes; a
  newcomer's offer on an already accepted call is answered with the shared local stream.
- `call.unavailable` for a GROUP frame drops one unanswered invitee; all-offline ends with
  `peer_offline`.
- `CallState` gains `conference`, `participants: [{userId, stream, connectionState}]` and
  `selectedPeerIds`; `peerUserId`/`remoteStream` remain for 1:1 compatibility.

## 4. Call layer UI (`CallLayer.tsx`)

- GROUP stage is a responsive grid: 1 remote, 2 remotes, 3+ remotes, plus the local preview
  tile. Remote tiles show the member's display name, initials avatar fallback and a
  «Подключается…»/error state; video replaces the avatar once a remote video track exists.
- Audio-only conferences render avatars and the participant count («Участников: N» including
  self), no empty black video tiles.
- Top badge shows participant count, connected timer, mute/camera/hangup controls; the hangup
  confirmation copy is group-specific. 1:1 layout, PiP preview and controls are unchanged.
- Incoming group dialog shows caller tiles, «Входящий групповой звонок», accept/reject, and an
  assertive announcement listing caller names.

## 5. Ringtone (`src/calls/ringtone.ts`)

- WebAudio only, no external assets: outgoing ringback is a quiet 1 s on / 2 s off loop;
  incoming is a short two-chirp signal every 2.4 s.
- Created lazily, started by `start`/`startConference` (user click) or the first incoming
  offer; stopped on first connection, accept, reject, cancel, failure, hangup, logout and
  layer teardown; `dispose()` closes the context. A missing/suspended AudioContext degrades to
  silence instead of throwing. Gain is low and output-only, so it does not feed the mic.

## 6. Managed/E2EE rules

- Calls are available for both DIRECT and GROUP only in MANAGED chats when the realtime socket
  is online and no call is active.
- In E2EE chats the header call buttons are disabled with «Звонки недоступны в E2EE-чатах»
  and the details footer call row is not rendered. `startCall`/`startGroupCall` re-check
  `isE2eeChat` in the store, so the rule does not depend on the UI alone.

## 7. Tests and verification

New/updated tests (25 new; suite 1021 → **1046**):

- `src/calls/Conference.test.ts` (12): one stream/three offers/shared call id; routed
  answer/ICE; per-leg failure; participant hangup/busy; explicit add/remove; incoming group
  accept-all and reject-all; newcomer join; group busy for another call; unattributed
  `call.unavailable`; 1:1 payload purity; ringback start/stop on media failure.
- `src/calls/ringtone.test.ts` (4): outgoing loop + stop, incoming chirp loop, suspended/absent
  context, context close on dispose.
- `src/components/Calls.test.tsx` (8 new): GROUP buttons enabled; picker from header and
  details, self excluded, min-1 rule, select-all, one-peer and 3-peer start; 3-peer
  answer/ICE relay, video grid and count; participant removal; incoming group accept; ringtone
  start/stop; axe with picker and with conference grid.
- `src/components/E2ee.test.tsx` (+1): E2EE disables header call buttons and hides the details
  call row.
- `src/realtime/protocol.test.ts`: GROUP `conference`/`recipients` and `call.unavailable`
  `from_user_id` survive parsing.

Fakes: `src/test/callFakes.ts` now also provides `createFakeRingtone`; `renderApp` accepts a
`ringtone` test seam.

Full verification (`cd frontend && npm run check`) — **pass**:

- `lint` 0 errors (4 pre-existing warnings in unrelated files);
- `format:check`, `contract:check`, `stickers:check`, `security:check`,
  `session-writers:check` pass;
- `vitest run`: **97 files / 1046 tests passed**;
- `build` (`tsc --noEmit` + vite) pass.

## 8. Known limitations / follow-ups

- Mesh is client-side only: without TURN, strict NAT/firewall peers still fall back to
  `connection_failed`; there is no SFU/mixer, so CPU/bandwidth grow with N.
- The picker lists the workspace ACTIVE directory because the contract exposes no per-chat
  member endpoint; the server is the final authority and rejects a non-chat recipient with
  `FORBIDDEN` (the whole attempt then fails honestly).
- Incoming/outgoing call history, recording, push and multi-device call handoff remain out of
  scope per #77.
