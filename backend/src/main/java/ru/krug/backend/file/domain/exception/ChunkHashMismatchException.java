package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Client-declared Content-SHA256 does not match the received bytes. 422. */
public class ChunkHashMismatchException extends DomainException {

    public ChunkHashMismatchException(int partNo, String expected, String actual) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.CHUNK_HASH_MISMATCH,
                "Chunk hash mismatch",
                Map.of("part_no", partNo, "expected", expected, "actual", actual), null);
    }
}
