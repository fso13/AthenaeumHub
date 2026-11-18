package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Workspace storage quota exhausted: used + reserved + requested > limit. 409. */
public class QuotaExceededException extends DomainException {

    public QuotaExceededException(long used, long reserved, long limit, long required) {
        super(ErrorCategory.CONFLICT, ErrorCode.QUOTA_EXCEEDED,
                "Workspace storage quota exceeded",
                Map.of("used", used, "reserved", reserved, "limit", limit,
                        "required", required), null);
    }
}
