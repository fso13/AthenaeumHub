package ru.krug.backend.notification.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Semantic preference error (unknown enum value, missing mode). Mapped to 422. */
public class NotificationPreferenceInvalidException extends DomainException {

    public NotificationPreferenceInvalidException(String field, Object value) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.VALIDATION_FAILED,
                "Notification preference is invalid",
                Map.of("field", field, "value", value == null ? "" : value.toString()), null);
    }
}
