package ru.krug.backend.sticker.domain.exception;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Unknown or inactive sticker. 404 STICKER_NOT_FOUND. */
public class StickerNotFoundException extends DomainException {

    public StickerNotFoundException(UUID stickerId) {
        super(ErrorCategory.NOT_FOUND, ErrorCode.STICKER_NOT_FOUND, "Sticker not found",
                Map.of("sticker_id", stickerId == null ? "" : stickerId.toString()), null);
    }
}
