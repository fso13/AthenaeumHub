package ru.krug.backend.file.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Attachment is in AV quarantine. 423, download and binding are blocked. */
public class AttachmentQuarantinedException extends DomainException {

    public AttachmentQuarantinedException(String scanStatus) {
        super(ErrorCategory.LOCKED, ErrorCode.ATTACHMENT_QUARANTINED,
                "Attachment is quarantined",
                Map.of("reason", "malware_scan", "scan_status",
                        scanStatus == null ? "" : scanStatus), null);
    }
}
