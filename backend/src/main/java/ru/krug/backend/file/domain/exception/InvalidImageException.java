package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * The bytes are not a valid supported static image: truncated/malformed header, missing
 * dimensions, an animated variant or a filename extension that contradicts the detected
 * magic. 422 {@code IMAGE_INVALID}.
 */
public class InvalidImageException extends DomainException {

    public InvalidImageException(String reason) {
        this(reason, Map.of());
    }

    public InvalidImageException(String reason, Map<String, Object> extra) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.IMAGE_INVALID, "Image is invalid",
                details(reason, extra), null);
    }

    private static Map<String, Object> details(String reason, Map<String, Object> extra) {
        java.util.LinkedHashMap<String, Object> details = new java.util.LinkedHashMap<>();
        details.put("field", "file");
        details.put("reason", reason);
        if (extra != null) {
            details.putAll(extra);
        }
        return details;
    }
}
