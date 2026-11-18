package ru.krug.backend.file.domain.exception;

import java.util.List;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Not every part/size/hash has arrived before complete. 422 INCOMPLETE_UPLOAD. */
public class IncompleteUploadException extends DomainException {

    public IncompleteUploadException(int expectedParts, int actualParts,
                                     List<Integer> missingParts) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.INCOMPLETE_UPLOAD,
                "Upload is incomplete",
                Map.of("expected_parts", expectedParts, "actual_parts", actualParts,
                        "missing_parts", missingParts), null);
    }
}
