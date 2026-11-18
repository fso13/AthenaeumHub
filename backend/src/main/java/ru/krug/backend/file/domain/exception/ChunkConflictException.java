package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** A part with the same number already has a different hash. 409 CHUNK_CONFLICT. */
public class ChunkConflictException extends DomainException {

    public ChunkConflictException(int partNo) {
        super(ErrorCategory.CONFLICT, ErrorCode.CHUNK_CONFLICT,
                "Chunk already exists with a different hash",
                Map.of("part_no", partNo), null);
    }
}
