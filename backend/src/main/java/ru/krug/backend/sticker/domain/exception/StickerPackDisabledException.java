package ru.krug.backend.sticker.domain.exception;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Pack is not ACTIVE: new sends are forbidden, old messages keep rendering. 409. */
public class StickerPackDisabledException extends DomainException {

    public StickerPackDisabledException(UUID packId, String status) {
        super(ErrorCategory.CONFLICT, ErrorCode.STICKER_PACK_DISABLED,
                "Sticker pack is disabled",
                Map.of("pack_id", packId == null ? "" : packId.toString(),
                        "status", status == null ? "" : status), null);
    }
}
