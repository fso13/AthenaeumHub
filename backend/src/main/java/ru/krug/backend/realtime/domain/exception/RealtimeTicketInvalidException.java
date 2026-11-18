package ru.krug.backend.realtime.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Invalid, expired, or already consumed ticket. Maps to HTTP 401 / close 4401. */
public class RealtimeTicketInvalidException extends DomainException {

    public RealtimeTicketInvalidException(String message) {
        super(ErrorCategory.UNAUTHORIZED, ErrorCode.WS_TICKET_INVALID, message, Map.of(), null);
    }
}
