package ru.krug.backend.realtime.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Device does not belong to the caller, or realtime access is otherwise forbidden (403). */
public class RealtimeForbiddenException extends DomainException {

    public RealtimeForbiddenException(String message) {
        super(ErrorCategory.FORBIDDEN, ErrorCode.WS_DEVICE_MISMATCH, message, Map.of(), null);
    }
}
