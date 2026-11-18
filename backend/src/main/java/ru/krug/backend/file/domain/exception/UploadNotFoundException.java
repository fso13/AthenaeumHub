package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Unknown upload or one invisible under RLS. 404 (existence is not disclosed). */
public class UploadNotFoundException extends DomainException {

    public UploadNotFoundException() {
        super(ErrorCategory.NOT_FOUND, ErrorCode.NOT_FOUND, "Upload not found", Map.of(), null);
    }
}
