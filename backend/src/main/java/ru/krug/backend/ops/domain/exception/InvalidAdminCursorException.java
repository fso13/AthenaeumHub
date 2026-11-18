package ru.krug.backend.ops.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Opaque admin cursor that cannot be decoded or belongs to another endpoint's page.
 * Mapped to 400 (never 500) so a tampered cursor cannot probe the keyset.
 */
public class InvalidAdminCursorException extends DomainException {

    public InvalidAdminCursorException() {
        super(ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                "Admin cursor is invalid", Map.of("field", "cursor"), null);
    }
}
