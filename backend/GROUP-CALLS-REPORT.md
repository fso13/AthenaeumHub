# #77 GROUP calls in GROUP channels (mesh, no SFU) — backend report

**Status: DONE**

Scope: backend WebSocket signalling for GROUP (multi-party) audio/video calls using a
client-side mesh. The server remains a stateless signalling relay: it does not mix or proxy
media, does not allocate conference/call state, does not persist anything, and does not use
TURN or an SFU. Frontend mesh orchestration, TURN/STUN deployment, push notifications,
recording, and multi-node fan-out are out of scope.

The change is **additive** to the existing `call.signal` protocol: DIRECT (1:1) frames and
their semantics are unchanged; GROUP frames add `conference:true` and an explicit
`recipients` list. Contract: `contracts/ws-protocol.md` §9.5 (and the updated summary rows
in §4 / events table).

## 1. What was built

The existing client frame `call.signal` can now target a GROUP chat. The server validates
the caller and every named recipient against ACTIVE chat membership, then relays the frame
only to live WS sessions of those recipients. The caller's own sessions are always excluded
(no echo). No conference registry, no `call.state`, no database migration, no SFU, no TURN,
no media handling, no server-side call history.

DIRECT keeps exactly the old behaviour: the recipient is the single other ACTIVE member,
and `conference`/`recipients` are rejected.

## 2. Exact protocol

### 2.1 Client → server: GROUP `call.signal`

Every GROUP frame (`offer`, `answer`, `ice`, `hangup`, `busy`) must carry both
`conference:true` and a non-empty `recipients` array:

```json
{
  "v": 1,
  "type": "call.signal",
  "chat_id": "11111111-1111-4111-8111-111111111111",
  "payload": {
    "call_id": "22222222-2222-4222-8222-222222222222",
    "kind": "offer",
    "video": true,
    "conference": true,
    "recipients": [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ],
    "sdp": "v=0\r\n...",
    "candidate": {"candidate": "candidate:...", "sdp_mid": "0", "sdp_mline_index": 0}
  }
}
```

Rules:

| Field | Rule |
| --- | --- |
| `call_id` | canonical UUID (36 chars) |
| `kind` | `offer`, `answer`, `ice`, `hangup`, `busy` |
| `video` | boolean; audio-only is `false` |
| `sdp` / `candidate` | same per-kind rules as DIRECT (`offer`/`answer` require SDP; `ice` requires candidate; `hangup`/`busy` forbid both) |
| `conference` | boolean; for GROUP it must be `true`. `false` is equivalent to omitted and makes the frame a non-conference frame, which GROUP rejects (422) |
| `recipients` | array of 1..50 canonical UUIDs, no duplicates, no caller. Only ACTIVE members of this GROUP chat |
| `recipients` without `conference:true` | 400 `WS_FRAME_INVALID` |
| `conference:true` without `recipients` | 400 `WS_FRAME_INVALID` |
| empty `recipients`, >50, duplicate or non-UUID entries | 400 `WS_FRAME_INVALID` |

`recipients` addresses **this particular frame**, not "everyone in the call". A participant
that answers the caller sends `recipients:[caller_id]`; a participant that wants to notify
several peers names those peers. The server never expands the list.

DIRECT: `conference:true` or a non-empty `recipients` is rejected with 400
`WS_FRAME_INVALID`; `conference:false` is equivalent to omitted, and DIRECT payloads without
those keys behave exactly as before.

### 2.2 Server → client: GROUP relay

The server relays the validated payload plus the authenticated sender ids:

```json
{
  "v": 1,
  "type": "event",
  "event": "call.signal",
  "workspace_id": "55555555-5555-4555-8555-555555555555",
  "chat_id": "11111111-1111-4111-8111-111111111111",
  "ts": "2026-11-19T10:00:00Z",
  "from_user_id": "66666666-6666-4666-8666-666666666666",
  "from_device_id": "77777777-7777-4777-8777-777777777777",
  "payload": {
    "call_id": "22222222-2222-4222-8222-222222222222",
    "kind": "offer",
    "video": true,
    "conference": true,
    "recipients": [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ],
    "sdp": "v=0\r\n..."
  }
}
```

- Delivered only to live WS sessions of the named recipients in the same workspace.
- All live sessions of each recipient receive the frame; answering is a client concern.
- The sender's own session is always excluded (no echo).
- Chat subscription is not required: a ringing GROUP call reaches a client that has not
  opened the chat.
- No `event_id`, no `seq`, no replay, no offline queue, no retry.
- Offline recipients are skipped. Frames are best-effort ephemeral (`ephemeral=true`).
- `recipients` in the relayed payload is the validated list the caller sent; the server never
  adds users to it.

### 2.3 `call.unavailable` for GROUP

If **no** live session of **any** named recipient receives the frame, the session that sent
the frame receives:

```json
{
  "v": 1,
  "type": "event",
  "event": "call.unavailable",
  "workspace_id": "55555555-5555-4555-8555-555555555555",
  "chat_id": "11111111-1111-4111-8111-111111111111",
  "ts": "2026-11-19T10:00:00Z",
  "payload": {
    "call_id": "22222222-2222-4222-8222-222222222222",
    "kind": "offer",
    "reason": "PEER_OFFLINE"
  }
}
```

`call.unavailable` is caller-session-only (not all of the caller's devices) and has no
`seq`/`event_id`. If at least one recipient session received the frame, no
`call.unavailable` is sent: **partial delivery is not an error** in this MVP.

### 2.4 Error mapping

| Situation | `error.code` | `status` |
| --- | --- | --- |
| Caller is not an ACTIVE chat member; foreign/unknown chat/workspace | `FORBIDDEN` | 403 |
| A `recipient` is not an ACTIVE member of this chat, or is foreign/unknown | `FORBIDDEN` | 403 |
| `recipient` equals the caller | `WS_FRAME_INVALID` | 400 |
| GROUP frame without `conference:true` / `recipients` | `CALL_NOT_SUPPORTED` | 422 |
| DIRECT frame with `conference:true` or non-empty `recipients` | `WS_FRAME_INVALID` | 400 |
| `recipients` empty, >50, duplicate, non-UUID, or without `conference:true` | `WS_FRAME_INVALID` | 400 |
| `conference:true` without `recipients` | `WS_FRAME_INVALID` | 400 |
| SDP > 32 KiB / candidate > 4 KiB | `CALL_PAYLOAD_TOO_LARGE` | 413 |
| Whole client frame > 64 KiB | `WS_FRAME_INVALID` | 400 (existing transport guard) |
| Per-session rate limit exhausted | `RATE_LIMITED` | 429 |

Every one of these errors is recoverable: the WS connection stays open and usable for
messages, `typing`, `presence`, and further call frames. Error text is generic and never
contains SDP/candidate content or reveals whether a chat/user exists.

## 3. Security and access model

| Check | Behaviour |
| --- | --- |
| Caller authentication | existing handshake ticket / active-device checks unchanged |
| Caller membership | `ChatAccessPort.findActiveChat`; no ACTIVE membership or foreign/unknown chat → `FORBIDDEN` 403 |
| Chat type | `RealtimeCallAccess` now exposes `chatType` (`DIRECT`/`GROUP`); unsupported types → `CALL_NOT_SUPPORTED` |
| Recipient validation (GROUP) | every recipient must be an ACTIVE `chat.chat_members` row of the same chat/workspace; otherwise generic `FORBIDDEN` 403 |
| Caller in recipients | rejected as `WS_FRAME_INVALID` 400 |
| Recipient fan-out | only the exact `recipientUserIds` resolved by the access gate; never all chat members |
| DIRECT ambiguity | more than one ACTIVE peer still fails closed with `CALL_NOT_SUPPORTED` (unchanged) |
| UUID validation | strict canonical 36-char UUIDs for `chat_id`, `call_id`, every recipient |
| Payload bounds | recipients ≤ 50, SDP ≤ 32 KiB UTF-8, candidate JSON ≤ 4 KiB, frame ≤ 64 KiB |
| Rate limit | existing per-session window (default 120 frames / 60 s, configurable) |
| Persistence | none: read-only membership/type queries only |
| Logging | no SDP/candidate/IP logging; `CallSignal.toString()` is redacted; debug logs carry only `call_id`, `kind`, `chat_type`, recipient count, delivered-session count |

A denial never distinguishes "chat does not exist", "caller is not a member", and "recipient
is not a member": all three return the same generic `FORBIDDEN`.

## 4. Implementation shape

- `CallSignal` gained `boolean conference` and `List<UUID> recipients` while keeping a
  DIRECT-compatible constructor; the model enforces 1..50 and uniqueness, the service
  rejects the caller as its own recipient, and `toString` stays redacted.
- `CallSignalParser` validates the new fields before any database access.
- `RealtimeCallAccess` now carries `chatType` and `recipientUserIds` (a `Set`, not "all
  members"), plus reasons `CONFERENCE_NOT_ALLOWED` and `RECIPIENTS_REQUIRED`.
- `RealtimeCallAccessAdapter` applies the DIRECT/GROUP rules and validates every GROUP
  recipient against ACTIVE membership.
- `CallSignalingService` maps access reasons to errors, checks caller-in-recipients, and
  relays to the resolved recipient set only. It keeps no conference/call state.
- `WsFrameCodec.callSignal` adds `conference`/`recipients` only for GROUP frames; DIRECT
  frames keep the old payload shape.
- `InMemoryRealtimeHub.relay` already filters by recipient user ids, excludes the sender
  session, skips offline/closed connections and never fans out to all members; only its
  documentation changed.
- `RealtimeWebSocketHandler` behaviour is unchanged except the comment: `UNAVAILABLE`
  produces `call.unavailable` on the sender session.

No `call.state`, no call registry, no call table, no migration, no SFU, no TURN, no media
plane.

## 5. Tests

New/updated coverage:

- `integration/RealtimeCallSignalingIT` (now 10 tests):
  1. DIRECT offer → answer → ICE → busy regression; no `conference`/`recipients` keys in
     DIRECT payloads; no replay after reconnect; SDP/candidate/IP log privacy.
  2. DIRECT offline peer → `call.unavailable` (`PEER_OFFLINE`).
  3. GROUP without recipients → `CALL_NOT_SUPPORTED` 422; foreign chat → `FORBIDDEN` 403;
     workspace member without chat membership → `FORBIDDEN` 403; socket survives.
  4. Oversized SDP/candidate → 413; malformed kind/missing video → 400; no peer relay.
  5. Per-session rate limit: 8 accepted, 9th → 429; socket survives.
  6. **3+ sessions GROUP conference**: caller + 3 recipients; every named recipient gets
     the offer; caller gets no echo; answer to caller reaches only the caller; busy from
     one participant reaches only the named caller and does not tear down the conference;
     GROUP SDP marker is absent from logs.
  7. **GROUP subset**: one offer to Bob only (Carol/Dave get nothing), next frame to
     Carol+Dave only (Bob gets nothing), no echo.
  8. **Non-member / unknown recipient**: workspace member outside the chat and a random
     UUID both → `FORBIDDEN` 403; nothing relayed; socket stays alive.
  9. **Offline partial**: Bob online, Carol offline → Bob gets the frame and the caller gets
     no `call.unavailable`; all-offline recipients → caller gets `PEER_OFFLINE`.
  10. **Malformed recipients / DIRECT regression**: empty, 51, duplicate, non-UUID,
      recipients without conference, conference without recipients, caller-in-recipients,
      DIRECT+conference → all 400; no relay; socket survives.
- `unit/RealtimeFrameContractTest`: new GROUP frame contract test (conference/recipients
  present, no `seq`/`event_id`); DIRECT test asserts the GROUP keys stay absent.
- `src/test/resources/contracts/ws-frames.schema.json`: `callSignal.payload` schema
  extended with optional `conference` and `recipients` (1..50 UUIDs).
- `unit/ChatKeysServiceDeviceGuardTest` and other callers compile against the extended model.

Commands (JDK 21, project-local Maven repo):

```bash
cd backend
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
mvn -o -Dmaven.repo.local="$PWD/.m2repo" test
```

Result: **592 tests, 0 failures / 0 errors / 0 skipped** (`BUILD SUCCESS`, 1:05 min).
This includes `RealtimeFrameContractTest` (13), `RealtimeCallSignalingIT` (10), and
`ArchitectureTest` (10).

Targeted run before the full suite:

```bash
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
mvn -o -Dmaven.repo.local="$PWD/.m2repo" \
  -Dtest=RealtimeFrameContractTest,RealtimeCallSignalingIT test
```

Result: **23 tests, 0 failures** (13 frame-contract unit tests + 10 integration tests).

`ArchitectureTest` is part of the full suite result and still passes: no new dependencies
from application/domain to infrastructure, transport types stay in
`realtime.infrastructure.ws`, and no domain cross-links were introduced.

## 6. Files

### New

- `backend/GROUP-CALLS-REPORT.md` (this report)

### Modified (main)

- `realtime/application/model/CallSignal.java` — `conference` + `recipients`, bounds,
  redacted `toString`, DIRECT-compatible constructor
- `realtime/application/model/RealtimeCallAccess.java` — `chatType`, recipient-set-based
  result, new denial reasons
- `realtime/application/model/CallSignalRelay.java` — documentation (recipient set)
- `realtime/application/model/CallKind.java` — documentation
- `realtime/application/port/RealtimeCallAccessPort.java` — recipients in the access gate
- `realtime/application/port/RealtimeCallSignalPort.java` — GROUP fan-out documentation
- `realtime/application/usecase/CallSignalingService.java` — GROUP access/relay, error
  mapping, caller-in-recipients check, safe debug logging
- `realtime/domain/exception/CallSignalRejectedException.java` — `recipientsRequired()`,
  `directConference()`, updated `CALL_NOT_SUPPORTED` text
- `realtime/infrastructure/adapter/RealtimeCallAccessAdapter.java` — DIRECT/GROUP rules and
  recipient validation
- `realtime/infrastructure/ws/CallSignalParser.java` — conference/recipients validation
- `realtime/infrastructure/ws/WsFrameCodec.java` — GROUP payload fields; `call.unavailable`
  documentation
- `realtime/infrastructure/ws/InMemoryRealtimeHub.java` — relay documentation only
- `realtime/infrastructure/ws/RealtimeWebSocketHandler.java` — documentation only
- `shared/error/ErrorCode.java` — comment update
- `CALLS-SIGNALING-REPORT.md` — pointer to the additive GROUP extension

### Modified (tests / contract)

- `backend/src/test/java/ru/krug/backend/integration/RealtimeCallSignalingIT.java`
- `backend/src/test/java/ru/krug/backend/unit/RealtimeFrameContractTest.java`
- `backend/src/test/resources/contracts/ws-frames.schema.json`
- `contracts/ws-protocol.md` — additive §9.5 and updated summary/limit rows

## 7. Configuration

No new configuration keys. GROUP calls reuse the existing call settings:

| Property | Default | Env |
| --- | --- | --- |
| `krug.realtime.call-signal-limit` | `120` | `KRUG_REALTIME_CALL_SIGNAL_LIMIT` |
| `krug.realtime.call-signal-window` | `60s` | `KRUG_REALTIME_CALL_SIGNAL_WINDOW` |
| `krug.realtime.call-sdp-max-bytes` | `32768` | `KRUG_REALTIME_CALL_SDP_MAX_BYTES` |
| `krug.realtime.call-candidate-max-bytes` | `4096` | `KRUG_REALTIME_CALL_CANDIDATE_MAX_BYTES` |

The `recipients` maximum of 50 is a protocol constant
(`CallSignal.MAX_RECIPIENTS`), not a tunable.

## 8. Known limitations / follow-ups

- Single node only: relay uses the in-process hub; multi-node needs pub/sub. The frame stays
  stateless, so no protocol change is required for a bus.
- Mesh is client-side and O(n²): the server does not mix media, allocate ports, or provide
  TURN. Large conferences are not a target of this slice.
- No offline delivery, push, retry, or conference state. If every named recipient is
  offline, only the sender gets `call.unavailable`; partial delivery is silent.
- `busy`/`hangup` from one participant is only a signal. The server does not end the call;
  the caller UI decides whether to continue the conference.
- Delivery is best-effort ephemeral: slow consumers can drop signalling frames; WebRTC
  renegotiation/ICE restart is the recovery mechanism.
- No SDP/candidate/IP logging, no call records, no recording, no analytics.

## 9. Verification

- `contracts/ws-protocol.md` §9.5 matches the implemented frame shape, recipient rules,
  `call.unavailable` semantics, error codes, and limits.
- DIRECT behaviour is covered by the original regression tests and by the explicit
  no-`conference`/`recipients` assertions.
- GROUP behaviour is covered end-to-end with real WS sessions and PostgreSQL (Testcontainers).
- The full backend suite including `ArchitectureTest` passes on JDK 21.

**DONE**
