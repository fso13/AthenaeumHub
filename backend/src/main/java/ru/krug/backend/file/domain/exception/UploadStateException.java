package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Upload is in a state that forbids the requested transition. 409. */
public class UploadStateException extends DomainException {

    public UploadStateException(String state, String action) {
        super(ErrorCategory.CONFLICT, ErrorCode.UPLOAD_STATE_CONFLICT,
                "Upload cannot be modified in its current state",
                Map.of("status", state, "action", action), null);
    }
}
