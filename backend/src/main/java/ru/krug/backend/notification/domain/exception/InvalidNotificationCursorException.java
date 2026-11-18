package ru.krug.backend.notification.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Opaque notification cursor that cannot be decoded. Mapped to 400. */
public class InvalidNotificationCursorException extends DomainException {

    public InvalidNotificationCursorException() {
        super(ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                "Notification cursor is invalid", Map.of("field", "cursor"), null);
    }
}
