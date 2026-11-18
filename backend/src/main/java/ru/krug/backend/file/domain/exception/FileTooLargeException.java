package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** File above the tariff/guest limit. Mapped to 413 FILE_TOO_LARGE. */
public class FileTooLargeException extends DomainException {

    public FileTooLargeException(String tariff, long limit, long actual) {
        super(ErrorCategory.PAYLOAD_TOO_LARGE, ErrorCode.FILE_TOO_LARGE,
                "File exceeds the workspace file size limit",
                Map.of("tariff", tariff, "limit", limit, "actual", actual), null);
    }
}
