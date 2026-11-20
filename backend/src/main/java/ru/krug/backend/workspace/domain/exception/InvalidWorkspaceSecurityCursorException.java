package ru.krug.backend.workspace.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Opaque security-surface cursor that cannot be decoded, belongs to another endpoint or
 * was issued for another workspace. Mapped to 400 (never 500) so a tampered cursor cannot
 * probe the keyset.
 */
public class InvalidWorkspaceSecurityCursorException extends DomainException {

    public InvalidWorkspaceSecurityCursorException() {
        super(ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                "Security cursor is invalid", Map.of("field", "cursor"), null);
    }
}
