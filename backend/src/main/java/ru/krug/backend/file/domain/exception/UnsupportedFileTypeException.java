package ru.krug.backend.file.domain.exception;

import java.util.List;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** MIME type outside the managed allowlist. 415 UNSUPPORTED_TYPE. */
public class UnsupportedFileTypeException extends DomainException {

    public UnsupportedFileTypeException(String mime, List<String> allowed) {
        super(ErrorCategory.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_TYPE,
                "File type is not supported", Map.of("mime", mime == null ? "" : mime,
                        "allowed", allowed), null);
    }
}
