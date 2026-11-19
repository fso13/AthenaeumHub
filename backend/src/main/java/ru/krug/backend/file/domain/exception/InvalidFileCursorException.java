package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Opaque file-center cursor that cannot be decoded, or one issued for another workspace.
 * Mapped to 400 (never 500) so a tampered cursor cannot probe the keyset.
 */
public class InvalidFileCursorException extends DomainException {

    public InvalidFileCursorException() {
        super(ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                "File cursor is invalid", Map.of("field", "cursor"), null);
    }
}
