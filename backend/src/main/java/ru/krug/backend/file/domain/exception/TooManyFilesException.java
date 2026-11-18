package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** More files than the tariff allows in one message/preflight. 422 TOO_MANY_FILES. */
public class TooManyFilesException extends DomainException {

    public TooManyFilesException(int limit, int actual) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.TOO_MANY_FILES,
                "Too many files in one request",
                Map.of("limit", limit, "actual", actual), null);
    }
}
