package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Invalid client supplied media metadata: unknown kind/source, out-of-bounds duration or
 * dimensions, unsafe/oversized strings, HTML/control characters, unsafe artwork URL, or a
 * MIME/kind mismatch. 422 MEDIA_METADATA_INVALID.
 */
public class MediaMetadataInvalidException extends DomainException {

    public MediaMetadataInvalidException(String field, String reason, Map<String, Object> extra) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.MEDIA_METADATA_INVALID,
                "Media metadata is invalid",
                details(field, reason, extra), null);
    }

    private static Map<String, Object> details(String field, String reason,
                                               Map<String, Object> extra) {
        java.util.LinkedHashMap<String, Object> details = new java.util.LinkedHashMap<>();
        details.put("field", field);
        details.put("reason", reason);
        if (extra != null) {
            details.putAll(extra);
        }
        return details;
    }
}
