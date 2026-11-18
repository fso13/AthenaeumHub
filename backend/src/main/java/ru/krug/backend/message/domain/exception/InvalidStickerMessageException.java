package ru.krug.backend.message.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * STICKER payload contract: exactly one sticker_id, no text and no attachments. Mixed or
 * incomplete payloads are 422 INVALID_STICKER_MESSAGE.
 */
public class InvalidStickerMessageException extends DomainException {

    public InvalidStickerMessageException(String reason, Map<String, Object> details) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.INVALID_STICKER_MESSAGE,
                "Invalid sticker message", merge(reason, details), null);
    }

    private static Map<String, Object> merge(String reason, Map<String, Object> details) {
        Map<String, Object> merged = new java.util.LinkedHashMap<>();
        merged.put("field", "sticker_id");
        merged.put("reason", reason);
        if (details != null) {
            merged.putAll(details);
        }
        return merged;
    }
}
