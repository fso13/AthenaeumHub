package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Part number outside 1..total_parts, or a part with an unexpected byte size. 422. */
public class InvalidChunkException extends DomainException {

    private InvalidChunkException(String code, String message, Map<String, Object> details) {
        super(ErrorCategory.UNPROCESSABLE, code, message, details, null);
    }

    public static InvalidChunkException outOfRange(int partNo, int totalParts) {
        return new InvalidChunkException(ErrorCode.PART_OUT_OF_RANGE,
                "Part number is outside the upload range",
                Map.of("part_no", partNo, "total_parts", totalParts));
    }

    public static InvalidChunkException sizeMismatch(int partNo, long expected, long actual) {
        return new InvalidChunkException(ErrorCode.CHUNK_SIZE_MISMATCH, "Chunk size mismatch",
                Map.of("part_no", partNo, "expected", expected, "actual", actual));
    }
}
