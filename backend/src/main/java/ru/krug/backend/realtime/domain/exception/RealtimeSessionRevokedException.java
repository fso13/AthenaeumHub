package ru.krug.backend.realtime.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** The device behind the session was revoked. Maps to session.revoked + close 4403. */
public class RealtimeSessionRevokedException extends DomainException {

    public RealtimeSessionRevokedException(String reason) {
        super(ErrorCategory.FORBIDDEN, ErrorCode.WS_SESSION_REVOKED, reason, Map.of(), null);
    }
}
