package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Stored object hash differs from the declared whole-file hash. 422. */
public class FileHashMismatchException extends DomainException {

    public FileHashMismatchException(String expected, String actual) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.FILE_HASH_MISMATCH,
                "Whole-file hash mismatch", Map.of("expected", expected, "actual", actual),
                null);
    }
}
