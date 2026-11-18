package ru.krug.backend.sticker.domain.exception;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Sticker was disabled/removed after being known. 410 STICKER_NOT_FOUND (history safe). */
public class StickerGoneException extends DomainException {

    public StickerGoneException(UUID stickerId, String status) {
        super(ErrorCategory.GONE, ErrorCode.STICKER_NOT_FOUND, "Sticker is no longer available",
                Map.of("sticker_id", stickerId == null ? "" : stickerId.toString(),
                        "status", status == null ? "" : status), null);
    }
}
