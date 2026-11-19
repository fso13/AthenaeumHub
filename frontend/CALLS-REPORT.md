# 1:1 audio/video calls — frontend report

**Status: DONE**

Scope: frontend 1:1 WebRTC calls over the existing `call.signal` WS relay
(`contracts/ws-protocol.md` §9, `backend/CALLS-SIGNALING-REPORT.md`). Only
`frontend/**` was changed: backend, contracts, docs, design and schema are
untouched. E2EE flag remains `false` for calls; the call path is managed-only
and never touches message plaintext, keys or the E2EE bridge.

## 1. What was built

### 1.1 Realtime transport

- `RealtimeClient.sendCallSignal(chatId, payload)` sends
  `{"v":1,"type":"call.signal","chat_id":...,"payload":{...}}` over the existing
  socket and returns `false` when the socket is not online, so the call engine
  can fail the attempt honestly.
- `protocol.ts` parses the relayed `event:"call.signal"` and
  `event:"call.unavailable"` envelopes. These are ephemeral: no `event_id`/`seq`
  is required (§2), and per-kind field rules are validated before the frame
  reaches the call engine (offer/answer require `sdp`; `ice` requires
  `candidate`; `hangup`/`busy` must not carry either).
- ICE candidates are normalized to `RTCIceCandidateInit` (`sdpMid`,
  `sdpMLineIndex`, `usernameFragment`). The parser also accepts the contract
  example's snake_case (`sdp_mid`, `sdp_mline_index`), because the backend relays
  the object byte-for-byte; the browser sender emits camelCase.
- Separate callbacks (`onCallSignal`, `onCallUnavailable`) keep these frames out
  of `ChatStore.handleRealtimeEvent`, whose dedupe requires `event_id` and whose
  events are durable chat events.
- MSW mock server now accepts `call.signal`, records the exact frames for tests,
  and provides helpers to publish relayed `call.signal` / `call.unavailable`
  events with the real envelope shape.

### 1.2 WebRTC engine (`src/calls/CallController.ts`)

- `getUserMedia` is called only from an explicit user action (`start`/`accept`);
  nothing runs on mount and there is no auto-call path. Audio is requested
  always (echo cancellation, noise suppression, AGC); video only for a video
  call.
- One `RTCPeerConnection` with `iceServers` from
  `VITE_WEBRTC_ICE_SERVERS`. Default is **empty** (no third-party STUN, host
  candidates only). TURN is not deployed in the MVP.
- Offer/answer/ICE are relayed over WS. Remote candidates that arrive before
  `setRemoteDescription` are buffered and flushed afterwards. Local candidates
  are sent as `kind:"ice"` with `RTCIceCandidateInit`.
- `busy` is sent when a second offer arrives while a call is already active;
  `hangup` is sent for explicit end/reject and for failures after an offer.
- `call.unavailable` (`PEER_OFFLINE`) ends the caller's attempt.
- Cleanup stops every local and remote track and closes the peer connection on
  hangup, busy, unavailable, connection failure, store reset, workspace switch,
  logout and layer unmount.
- Client-side size guards mirror §9.4: SDP ≤32 KiB UTF-8, candidate JSON
  ≤4 KiB. `sdp`/`candidate` are never logged and never sent to REST.

### 1.3 Store state

`AppState.call` is an in-memory `CallState` (phase, call id/chat/direction,
video, peer, muted, camera, media-pending, started-at, local/remote streams,
transient notice). Streams and peer connections are never persisted. Public
actions: `startCall`, `acceptIncomingCall`, `rejectIncomingCall`, `endCall`,
`toggleCallMute`, `toggleCallCamera`, `dismissCallNotice`. Incoming signals for
a known non-DIRECT chat are ignored defensively; server errors
`CALL_NOT_SUPPORTED`, `CALL_PAYLOAD_TOO_LARGE`, and call-time
`FORBIDDEN`/`RATE_LIMITED`/`WS_FRAME_INVALID` fail only the call, never the WS.

### 1.4 UI (`CallLayer`, `ChatHeader`)

- Header Phone/Video buttons are enabled only for `DIRECT` while the realtime
  socket is online; `GROUP` is disabled with the honest title
  «Звонки доступны только в личных чатах», offline — «Нет соединения с
  live-сервером — звонки недоступны». A second attempt during an active call is
  disabled.
- Outgoing overlay: requesting media → calling → connecting → connected with a
  live timer. Incoming: peer name, audio/video kind, «Принять»/«Отклонить».
  Connected: mute, camera (video only), hangup; local PiP preview and remote
  video on the stage. Audio-only calls keep the same `<video>` element so remote
  audio plays.
- `CallLayer` is mounted once in `AppShell`, so an incoming call is visible
  while the user is reading another chat (chat subscription is not required by
  §9.2).
- `Escape` on a connected call opens an explicit «Завершить звонок?»
  confirmation (accidental drops prevented); on a ringing call it declines,
  since no media exists yet.
- Permission/device/insecure-context/signalling/connection errors are shown as
  a dismissible `role="alert"` notice with RU copy. Status changes use
  `role="status" aria-live="polite"`; the ringing dialog adds an assertive
  announcement.
- Incoming dialog: `role="dialog"`, `aria-modal`, labelled + described, focus
  trap, initial focus on «Принять», focus return on close. On ≤640 px the call
  surface is full-screen (`100dvh`, safe-area padding).

## 2. Configuration

| Env                       | Default | Meaning                                                                                                                                       |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_WEBRTC_ICE_SERVERS` | empty   | comma/space separated `stun:`/`stuns:`/`turn:`/`turns:` URLs. Empty → host candidates only, no third-party STUN. Invalid schemes are ignored. |

No TURN server is deployed. Consequence: peers behind symmetric NAT / strict
firewalls, or without a usable host candidate pair, cannot connect. A TURN
service is a deployment follow-up, not an MVP feature. The call UI reports
`connection_failed` rather than hanging silently in that case.

## 3. Security and privacy

| Check          | Result                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DIRECT-only    | UI disables GROUP; store re-checks `ChatSummary.type`; controller defends against stray non-DIRECT signals; server is the final authority |
| Media path     | peer-to-peer WebRTC only; no media/REST upload to the server                                                                              |
| Logging        | no `sdp`, `candidate`, IP, track or media logging anywhere in the call path                                                               |
| Persistence    | no call state/history in localStorage, sessionStorage, IndexedDB or store persistence; streams are in-memory only                         |
| Payload bounds | SDP ≤32 KiB, candidate ≤4 KiB checked before send; server enforces too                                                                    |
| E2EE           | calls are managed-only; E2EE flag untouched, no E2EE keys/plaintext involved                                                              |
| Errors         | call-only server errors end the call without closing the WS or affecting messaging                                                        |
| getUserMedia   | requested only after explicit call/accept; no permission prompt on app mount                                                              |

## 4. Tests

New suites (23 tests):

- `src/calls/CallController.test.ts` (9) — no media before start; audio-only
  constraints; offer relay + configurable ICE servers; incoming offer with
  buffered ICE; local/remote ICE; busy on second offer; mute/camera + track stop
  - PC close; permission error mapping; `call.unavailable`; remote track +
    connection failure.
- `src/components/Calls.test.tsx` (11) — GROUP buttons disabled with honest
  title; outgoing audio call offer/ICE/connect/mute/confirm hangup; video call
  local preview/remote track/camera toggle/Escape confirm; incoming call on
  another chat with focus trap, buffered ICE, accept and remote hangup; reject
  without media; busy; permission error; device error; peer offline; failed
  connection; axe audit (serious/critical = 0) with the incoming dialog open.
- `src/realtime/RealtimeClient.test.ts` (+1) — call frames routed to call
  callbacks, `sendCallSignal` wire shape, `false` when offline.
- `src/realtime/protocol.test.ts` (+1) — call/unavailable parsing without
  `event_id`, ICE snake_case/camelCase normalization, per-kind rejection.
- `src/config/env.test.ts` (+1) — no-STUN default and ICE env parsing.

Fakes: `src/test/callFakes.ts` provides `getUserMedia`/`RTCPeerConnection`
double (ICE, tracks, connection state, failures); the mock WS relays/records
`call.signal` frames. No real media device or browser peer is required.

Full verification:

```bash
cd frontend
npm run check
```

- `npm run lint` — 0 errors (3 pre-existing warnings in unrelated files).
- `npm run format:check` — pass.
- `npm run contract:check`, `stickers:check`, `security:check`,
  `session-writers:check` — pass.
- `npm test` — see §6 for the exact final numbers.
- `npm run build` — pass.
- Existing unit suites for chat, realtime, notifications, dashboard and settings
  remain green; the full run has only the known pre-existing timing flake in
  `Notifications.test.tsx` («loading state while the first page is in flight»),
  which also fails on the untouched baseline and passes when the file runs
  alone with the adjacent suites.
- E2E specs were not modified; call additions are covered by unit/RTL tests
  (MSW + fake WebRTC), and the e2e surface/selectors used by chat tests are
  unchanged. The D1 visual screenshots are informational (no snapshot
  assertions).

## 5. Files

New:

- `src/calls/types.ts` — protocol/state/error types, bounds.
- `src/calls/CallController.ts` — WebRTC engine.
- `src/calls/CallController.test.ts` — engine tests.
- `src/components/CallLayer.tsx` — incoming/outgoing overlay, controls, notice.
- `src/components/Calls.test.tsx` — RTL/axe suite.
- `src/test/callFakes.ts` — media/RTCPeerConnection fakes.

Modified:

- `src/realtime/protocol.ts` — `call.signal`/`call.unavailable` frames + parser.
- `src/realtime/RealtimeClient.ts` — call callbacks + `sendCallSignal`.
- `src/store/chatStore.ts` — call state/actions, signal routing, cleanup.
- `src/components/ChatHeader.tsx` — DIRECT-only call actions.
- `src/components/ChatScreen.tsx` — passes call action.
- `src/components/AppShell.tsx` — mounts `CallLayer`.
- `src/components/Icons.tsx` — mic-off/video-off/phone-off icons.
- `src/config/env.ts` — `webrtcIceServers` + parser.
- `src/i18n/ru.ts` — call copy and error mapping.
- `src/styles/app.css` — overlay/dialog/control/notice styles, mobile full-screen.
- `src/mocks/realtime.ts` — call frame relay/record + publish helpers.
- `src/test/renderApp.tsx` — optional call media seams.
- `src/realtime/RealtimeClient.test.ts`, `src/realtime/protocol.test.ts`,
  `src/config/env.test.ts` — call coverage.
- `README.md`, `.env.example` — env + call behavior documentation.

## 6. Known limitations / follow-ups

- 1:1 DIRECT only; no group calls, no call transfer, no recording, no call
  history (the server deliberately stores nothing).
- No TURN in the MVP: symmetric-NAT/firewall cases can fail to connect; UI shows
  `connection_failed`. Deploying TURN + a `VITE_WEBRTC_ICE_SERVERS` entry is the
  follow-up.
- No push notification/ring for a closed tab; `call.signal` is ephemeral and
  offline delivery does not exist. `call.unavailable` covers the caller's
  offline-peer case.
- No explicit `ringing` frame exists in §9; the caller UI shows «Вызываем…»
  until the answer arrives (hence no fake ring state).
- WebRTC media survives a WS drop while connected; signalling-dependent actions
  (hangup delivery) may be lost until reconnect. Connection failure still
  surfaces through `connectionState`.
- Browser autoplay policies can delay remote audio until the user gesture that
  started/accepted the call; the UI does not show a separate "tap to play"
  affordance in this slice.
- Calls are managed-only; E2EE call media is out of scope (the E2EE flag stays
  false).
