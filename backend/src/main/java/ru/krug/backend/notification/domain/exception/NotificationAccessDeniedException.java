package ru.krug.backend.notification.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Preference update for a chat the caller is not an active member of. Mapped to 403. */
public class NotificationAccessDeniedException extends DomainException {

    public NotificationAccessDeniedException(String message) {
        super(ErrorCategory.FORBIDDEN, ErrorCode.FORBIDDEN, message, Map.of(), null);
    }
}
