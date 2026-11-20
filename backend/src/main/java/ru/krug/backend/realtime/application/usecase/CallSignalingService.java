package ru.krug.backend.realtime.application.usecase;

import java.util.Set;
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
 * Authorises and relays one call-signalling frame.
 *
 * <p>DIRECT keeps the original 1:1 semantics. GROUP is a server-side fan-out of mesh
 * signalling: the caller names up to {@value CallSignal#MAX_RECIPIENTS} ACTIVE chat members,
 * the frame is relayed only to their live sessions, and no conference state, mixing, SFU,
 * persistence, push notification or offline queue exists. The media mesh itself is built by
 * the clients. A busy/hangup from one participant is just a signal to the recipients it
 * names; the server never tears a conference down.
 *
 * <p>Never log {@code signal}; its record {@code toString()} is redacted and this class logs
 * only the call id/kind, chat type, recipient count and delivered-session count.
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
        // The caller can never be its own recipient: this is a client error independent of
        // chat type, so reject before touching membership.
        if (signal.recipients().contains(session.userId())) {
            throw CallSignalRejectedException.malformed(
                    "payload.recipients must not include the caller");
        }

        RealtimeCallAccess access = callAccess.check(session.workspaceId(), chatId,
                session.userId(), signal.conference(), Set.copyOf(signal.recipients()),
                "realtime:" + session.sessionId());
        if (!access.accepted()) {
            throw rejectionFor(access.reason());
        }

        // The adapter already resolved the exact target users: exactly one peer for DIRECT,
        // or the validated explicit subset for GROUP. Never replace this with "all members".
        Set<UUID> recipients = access.recipientUserIds();
        if (recipients.isEmpty()) {
            return CallSignalOutcome.UNAVAILABLE;
        }

        int delivered = callSignalPort.relay(new CallSignalRelay(access.workspaceId(), chatId,
                recipients, session.userId(), session.deviceId(), signal, clock.now()),
                session.sessionId());
        if (log.isDebugEnabled()) {
            log.debug("call.signal session_id={} chat_id={} call_id={} kind={} chat_type={}"
                            + " conference={} recipients={} recipient_sessions={}",
                    session.sessionId(), chatId, signal.callId(), signal.kind(),
                    access.chatType(), signal.conference(), recipients.size(), delivered);
        }
        // A conference (and a 1:1 call) must keep ringing when the peer is offline;
        // the client retries the offer when presence turns ONLINE. Zero deliveries
        // is not an error and must not tear the call down.
        return CallSignalOutcome.RELAYED;
    }

    private static CallSignalRejectedException rejectionFor(String reason) {
        if (RealtimeCallAccess.NOT_SUPPORTED.equals(reason)) {
            return CallSignalRejectedException.notSupported();
        }
        if (RealtimeCallAccess.CONFERENCE_NOT_ALLOWED.equals(reason)) {
            return CallSignalRejectedException.directConference();
        }
        if (RealtimeCallAccess.RECIPIENTS_REQUIRED.equals(reason)) {
            return CallSignalRejectedException.recipientsRequired();
        }
        return CallSignalRejectedException.forbidden();
    }

    /** Drops rate-limit state for a closed session. */
    public void forget(String sessionId) {
        rateLimiter.forget(sessionId);
    }
}
