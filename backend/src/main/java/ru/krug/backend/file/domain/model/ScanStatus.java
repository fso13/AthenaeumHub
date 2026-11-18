package ru.krug.backend.file.domain.model;

/**
 * Malware scan outcome for a managed attachment. Fail-closed: only CLEAN is downloadable.
 * SKIPPED is reserved for E2EE files, which are out of this slice, but is part of the
 * contract enum so future adapters do not need a schema change.
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
