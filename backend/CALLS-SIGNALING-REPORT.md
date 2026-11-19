# 1:1 audio/video call signalling — backend report

**Status: DONE**

Scope: backend WebSocket signalling for 1:1 (DIRECT) audio/video calls. WebRTC media is
peer-to-peer and is not handled by the server. Frontend work, TURN/STUN deployment, push
notifications, and multi-node fan-out are out of scope.

## 1. What was built

The existing WS protocol now has a client frame `call.signal` and two server events:

| Direction | Frame | Meaning |
| --- | --- | --- |
| client → server | `type=call.signal` | offer / answer / ICE / hangup / busy for one DIRECT chat |
| server → peer | `type=event`, `event=call.signal` | the validated payload relayed to the other member's live sessions |
| server → caller | `type=event`, `event=call.unavailable` | no live session of the peer exists |

There is deliberately **no** `call.state` frame, no call registry, no REST call record, no
database migration, and no persistence of any kind. The server does not allocate `call_id`:
the caller does, and the value is opaque to the server.

The relayed frame puts `from_user_id`/`from_device_id` at the envelope level and keeps
`payload` byte-identical to the validated client payload (same `call_id`, `kind`, `video`,
`sdp`/`candidate`).

## 2. Delivery semantics

- Recipients: all live WS sessions whose user is an ACTIVE member of the DIRECT chat other
  than the caller, in the same resolved workspace. Chat subscription is not required, so a
  ringing call can reach a client that has not opened the chat.
- All peer devices receive the frame; the answering device's frames go back to all live
  sessions of the caller.
- The sender's own session is always excluded (no echo).
- If zero peer sessions receive the frame, the caller's session gets
  `call.unavailable` with `reason=PEER_OFFLINE`. There is no offline queue.
- Frames are ephemeral: `OutboundFrame.ephemeral=true` (dropped first under backpressure),
  no `seq`, no `event_id`, no replay. A reconnect replays chat messages only.
- `call.unavailable` is delivered only to the session that sent the signal, not to all of
  the caller's devices.

## 3. Security

| Check | Result |
| --- | --- |
| Authenticated session | existing ticket/device checks unchanged |
| ACTIVE membership | `ChatAccessPort.findActiveChat`; denial / foreign chat → `FORBIDDEN` (status 403) |
| DIRECT only | chat type is now part of `ChatAccess`; GROUP → `CALL_NOT_SUPPORTED` (status 422) |
| Ambiguous DIRECT | more than one peer member → `CALL_NOT_SUPPORTED` (fail closed, never group-broadcast) |
| UUID validation | strict canonical 36-char UUID for `chat_id` and `payload.call_id` |
| Kind validation | only `offer`, `answer`, `ice`, `hangup`, `busy`; per-kind field rules |
| Payload bounds | SDP ≤ 32 KiB UTF-8, candidate JSON ≤ 4 KiB, frame ≤ 64 KiB |
| Rate limit | fixed 60 s window per session, default 120 signals (configurable) |
| Insufficient role/access | generic error text, no chat-existence leak |
| Persistence | none (read-only membership/type queries only) |
| Logging | no SDP/candidate/IP logging; `CallSignal.toString()` is redacted; debug logs carry only `call_id`, `kind`, recipient count |

Errors for `call.signal` are recoverable: an `error` frame is sent and the connection stays
open, so a malformed call frame cannot break typing/presence/messaging on the same socket.
Other invalid frames keep the legacy 1008 close behaviour.

Error mapping:

| Code | status | When |
| --- | --- | --- |
| `WS_FRAME_INVALID` | 400 | malformed payload, wrong types, bad UUID, unknown kind |
| `FORBIDDEN` | 403 | non-member / foreign / unknown chat |
| `CALL_PAYLOAD_TOO_LARGE` | 413 | SDP or candidate above the bound |
| `CALL_NOT_SUPPORTED` | 422 | non-DIRECT chat (or a DIRECT with >1 active peer) |
| `RATE_LIMITED` | 429 | per-session window exhausted |

## 4. Configuration

`krug.realtime` additions (env overrides in `application.yml`):

| Property | Default | Env |
| --- | --- | --- |
| `call-signal-limit` | `120` | `KRUG_REALTIME_CALL_SIGNAL_LIMIT` |
| `call-signal-window` | `60s` | `KRUG_REALTIME_CALL_SIGNAL_WINDOW` |
| `call-sdp-max-bytes` | `32768` | `KRUG_REALTIME_CALL_SDP_MAX_BYTES` |
| `call-candidate-max-bytes` | `4096` | `KRUG_REALTIME_CALL_CANDIDATE_MAX_BYTES` |

## 5. Files

### New (main)

- `realtime/application/model/CallKind.java`
- `realtime/application/model/CallSignal.java` (redacted `toString`)
- `realtime/application/model/CallSignalRelay.java`
- `realtime/application/model/CallSignalOutcome.java`
- `realtime/application/model/RealtimeCallAccess.java`
- `realtime/application/port/RealtimeCallAccessPort.java`
- `realtime/application/port/RealtimeCallSignalPort.java`
- `realtime/application/service/CallSignalRateLimiter.java`
- `realtime/application/usecase/CallSignalingService.java`
- `realtime/domain/exception/CallSignalRejectedException.java`
- `realtime/infrastructure/adapter/RealtimeCallAccessAdapter.java`
- `realtime/infrastructure/ws/CallSignalParser.java`

### Modified (main)

- `shared/error/ErrorCode.java` — `CALL_NOT_SUPPORTED`, `CALL_PAYLOAD_TOO_LARGE`
- `chat/application/model/ChatAccess.java` — added `chatType`
- `chat/application/usecase/ChatAccessService.java` — populates `chatType`
- `realtime/application/port/RealtimeSettingsPort.java` + adapter/properties
- `realtime/infrastructure/ws/WsFrameCodec.java` — `call.signal`, `call.unavailable`, optional `status` on `error`
- `realtime/infrastructure/ws/InMemoryRealtimeHub.java` — implements `RealtimeCallSignalPort`
- `realtime/infrastructure/ws/RealtimeWebSocketHandler.java` — `call.signal` branch, recoverable errors, limiter cleanup
- `realtime/infrastructure/ws/RealtimeWebSocketConfig.java` — fixed WS buffer limit (see §7)
- `resources/application.yml` — call limits

### Tests

- `integration/RealtimeCallSignalingIT.java` (new, 5 tests)
- `unit/RealtimeFrameContractTest.java` (new call frame/schema/redaction assertions)
- `test/resources/contracts/ws-frames.schema.json` (`callSignal`, `callUnavailable`)
- `unit/ChatKeysServiceDeviceGuardTest.java` (ChatAccess constructor)

### Contract

- `contracts/ws-protocol.md` — additive §9 plus table rows; no existing frame changed

## 6. Tests and results

Commands (Java 21, project-local Maven repo):

```bash
cd backend
JAVA_HOME=/opt/homebrew/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home \
mvn -o -Dmaven.repo.local="$PWD/.m2repo" -Dtest=RealtimeFrameContractTest,RealtimeCallSignalingIT test
```

Result: **17 tests, 0 failures** (12 frame-contract unit tests + 5 integration tests).

Final verification on 2026-11-19 also ran `RealtimeWebSocketIT`, `ArchitectureTest`,
`RealtimeTicketIT`, `RealtimeConnectionTest`, `SubscriptionServiceTest` and
`ChatKeysServiceDeviceGuardTest`: **56 tests, 0 failures** across the two runs.

Integration coverage (`RealtimeCallSignalingIT`, signal limit lowered to 8 for the test):

1. offer → answer → ICE both ways → busy relayed between two sessions; envelope has
   `from_*`, payload unchanged, no `seq`/`event_id`; no replay after reconnect.
2. Offline peer → `call.unavailable` (`PEER_OFFLINE`) to the caller only.
3. GROUP → `CALL_NOT_SUPPORTED` 422; foreign chat → `FORBIDDEN` 403; workspace member
   without chat membership → `FORBIDDEN` 403; socket stays usable (ping/pong).
4. Oversized SDP and oversized candidate → `CALL_PAYLOAD_TOO_LARGE` 413; bad kind and
   missing `video` → `WS_FRAME_INVALID` 400; no peer relay.
5. Per-session rate limit: 8 accepted hangups, 9th → `RATE_LIMITED` 429, socket survives.

Log privacy is asserted in test 1: a TRACE appender on `ru.krug.backend` captures all
application logs while an offer with a unique SDP marker, an ICE candidate with a unique
marker and a documentation IP is relayed; none of the markers or the IP appears in logs.

Regression runs:

- `RealtimeWebSocketIT` — 10/10 passed (typing/presence/replay/tickets unaffected)
- `RealtimeTicketIT` — 4/4 passed
- `RealtimeConnectionTest` — 1/1 passed
- `RealtimeFrameContractTest` — 12/12 passed
- `SubscriptionServiceTest` — 9/9 passed
- `ChatKeysServiceDeviceGuardTest` — 5/5 passed (constructor updated)
- `ArchitectureTest` — 10/10 passed

## 7. Pre-existing bug fixed: WS frame buffer

`RealtimeWebSocketConfig` already intended a 64 KiB WS frame cap, but the
`ServletContextInitializer` ran before Tomcat created `WsServerContainer`, so the attribute
was always `null` and Tomcat kept its 8 KiB default. Any frame above 8 KiB closed with 1009.
This made a legal 32 KiB SDP impossible and would also have affected large E2EE envelopes.

The limit is now set through a `WebServerFactoryCustomizer<TomcatServletWebServerFactory>`
that adds the `org.apache.tomcat.websocket.textBufferSize` / `binaryBufferSize` context
parameters before the context starts. Verified by the oversized-SDP integration test.

## 8. Known limitations / follow-ups

- Single node only: relay uses the in-process hub. Multi-node needs a pub/sub bus; the
  signalling frame is intentionally stateless, so a bus can be added without protocol
  changes.
- No offline delivery or push notification for calls; the caller gets `call.unavailable`.
- No server-side media, TURN, recording, call history, or analytics.
- Rate limiting is in-process and per WS session (resets on reconnect), by design.
- `call.signal` delivery is best-effort ephemeral: a slow consumer can drop signalling
  frames; WebRTC renegotiation/ICE restart is the recovery mechanism.
