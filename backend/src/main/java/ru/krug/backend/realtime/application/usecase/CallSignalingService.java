package ru.krug.backend.realtime.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.realtime.application.model.CallSignal;
import ru.krug.backend.realtime.application.model.CallSignalOutcome;
import ru.krug.backend.realtime.application.model.CallSignalRelay;
import ru.krug.backend.realtime.application.model.RealtimeCallAccess;
import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.port.RealtimeCallAccessPort;
import ru.krug.backend.realtime.application.port.RealtimeCallSignalPort;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.application.service.CallSignalRateLimiter;
import ru.krug.backend.realtime.domain.exception.CallSignalRejectedException;
import ru.krug.backend.realtime.domain.exception.RealtimeSessionRevokedException;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Authorises and relays one 1:1 signalling frame. There is no call registry: the server
 * does not allocate call ids, inspect SDP, persist state, send push notifications, or queue
 * for offline peers. The only server-side decision is who may receive the frame now.
 *
 * <p>Never log {@code signal}; its record {@code toString()} is redacted and this class logs
 * only the call id/kind and peer-session count.
 */
@Service
public class CallSignalingService {

    private static final Logger log = LoggerFactory.getLogger(CallSignalingService.class);

    private final RealtimeCallAccessPort callAccess;
    private final RealtimeCallSignalPort callSignalPort;
    private final RealtimeDevicePort devicePort;
    private final RealtimeSettingsPort settings;
    private final CallSignalRateLimiter rateLimiter;
    private final ClockPort clock;

    public CallSignalingService(RealtimeCallAccessPort callAccess,
                                RealtimeCallSignalPort callSignalPort,
                                RealtimeDevicePort devicePort, RealtimeSettingsPort settings,
                                CallSignalRateLimiter rateLimiter, ClockPort clock) {
        this.callAccess = callAccess;
        this.callSignalPort = callSignalPort;
        this.devicePort = devicePort;
        this.settings = settings;
        this.rateLimiter = rateLimiter;
        this.clock = clock;
    }

    public CallSignalOutcome signal(RealtimeSession session, UUID chatId, CallSignal signal) {
        // Rate-limit before any database work: a hostile socket must not amplify queries.
        if (!rateLimiter.tryAcquire(session.sessionId(), clock.now(), settings.callSignalLimit(),
                settings.callSignalWindow())) {
            throw CallSignalRejectedException.rateLimited();
        }
        if (!devicePort.isActiveDeviceOfUser(session.deviceId(), session.userId())) {
            throw new RealtimeSessionRevokedException("DEVICE_REVOKED");
        }

        RealtimeCallAccess access = callAccess.check(session.workspaceId(), chatId,
                session.userId(), "realtime:" + session.sessionId());
        if (!access.accepted()) {
            if (RealtimeCallAccess.NOT_DIRECT.equals(access.reason())) {
                throw CallSignalRejectedException.notSupported();
            }
            throw CallSignalRejectedException.forbidden();
        }

        List<UUID> peers = new ArrayList<>(access.memberUserIds());
        peers.removeIf(userId -> userId.equals(session.userId()));
        // A DIRECT chat has exactly one peer. More active members means a corrupted chat:
        // fail closed instead of broadcasting a 1:1 call to a group.
        if (peers.size() > 1) {
            throw CallSignalRejectedException.notSupported();
        }
        if (peers.isEmpty()) {
            return CallSignalOutcome.UNAVAILABLE;
        }

        int delivered = callSignalPort.relay(new CallSignalRelay(access.workspaceId(), chatId,
                java.util.Set.copyOf(peers), session.userId(), session.deviceId(), signal,
                clock.now()), session.sessionId());
        if (log.isDebugEnabled()) {
            log.debug("call.signal session_id={} chat_id={} call_id={} kind={} peer_sessions={}",
                    session.sessionId(), chatId, signal.callId(), signal.kind(), delivered);
        }
        return delivered == 0 ? CallSignalOutcome.UNAVAILABLE : CallSignalOutcome.RELAYED;
    }

    /** Drops rate-limit state for a closed session. */
    public void forget(String sessionId) {
        rateLimiter.forget(sessionId);
    }
}
