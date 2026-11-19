package ru.krug.backend.file.domain.exception;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** MIME/extension outside the managed allowlist. 415 UNSUPPORTED_TYPE. */
public class UnsupportedFileTypeException extends DomainException {

    public UnsupportedFileTypeException(String mime, List<String> allowed) {
        this(mime, "", allowed);
    }

    public UnsupportedFileTypeException(String mime, String extension, List<String> allowed) {
        super(ErrorCategory.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_TYPE,
                "File type is not supported", details(mime, extension, allowed), null);
    }

    private static Map<String, Object> details(String mime, String extension,
                                               List<String> allowed) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("mime", mime == null ? "" : mime);
        if (extension != null && !extension.isBlank()) {
            details.put("extension", extension);
        }
        details.put("allowed", allowed == null ? List.of() : allowed);
        return details;
    }
}
