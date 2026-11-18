package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Executable/script blocked by policy. 422 DANGEROUS_TYPE_BLOCKED. */
public class DangerousFileTypeException extends DomainException {

    public DangerousFileTypeException(String mime, String filename) {
        super(ErrorCategory.UNPROCESSABLE, ErrorCode.DANGEROUS_TYPE_BLOCKED,
                "Dangerous file type is blocked",
                Map.of("mime", mime == null ? "" : mime, "filename", filename,
                        "policy", "managed-allowlist"), null);
    }
}
