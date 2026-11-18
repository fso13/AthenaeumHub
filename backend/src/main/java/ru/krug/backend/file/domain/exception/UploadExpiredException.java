package ru.krug.backend.file.domain.exception;

import java.time.Instant;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Upload TTL elapsed. 410 UPLOAD_EXPIRED. */
public class UploadExpiredException extends DomainException {

    public UploadExpiredException(Instant expiredAt) {
        super(ErrorCategory.GONE, ErrorCode.UPLOAD_EXPIRED, "Upload session expired",
                Map.of("expired_at", expiredAt == null ? "" : expiredAt.toString()), null);
    }
}
