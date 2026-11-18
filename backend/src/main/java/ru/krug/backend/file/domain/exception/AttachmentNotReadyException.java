package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Attachment is not READY/CLEAN yet (scan pending, unbound, or already bound). 409. */
public class AttachmentNotReadyException extends DomainException {

    public AttachmentNotReadyException(String status, String scanStatus) {
        super(ErrorCategory.CONFLICT, ErrorCode.ATTACHMENT_NOT_READY,
                "Attachment is not ready",
                Map.of("status", status == null ? "" : status,
                        "scan_status", scanStatus == null ? "" : scanStatus), null);
    }
}
