package ru.krug.backend.file.domain.model;

/**
 * Malware scan outcome for a managed attachment. Fail-closed: only CLEAN is downloadable.
 * SKIPPED is reserved for the trusted direct-image pipeline ({@code POST /media/images}),
 * where the parser accepts only static PNG/JPEG/WebP bytes and no generic file can use the
 * path; it remains part of the contract enum for compatibility. It is not a way to bypass a
 * pending/negative scan for upload-path attachments.
 */
public enum ScanStatus {
    PENDING,
    CLEAN,
    INFECTED,
    FAILED,
    SKIPPED;

    public boolean downloadable() {
        return this == CLEAN || this == SKIPPED;
    }

    public boolean quarantined() {
        return this == INFECTED || this == FAILED;
    }
}
