package ru.krug.backend.file.domain.model;

/**
 * Upload lifecycle from contracts/openapi.yaml UploadSession.status.
 * E2EE statuses are intentionally absent: this slice is managed-only (E4-D-01).
 */
public enum UploadStatus {
    INIT,
    UPLOADING,
    PAUSED,
    COMPLETING,
    SCANNING,
    READY,
    QUARANTINED,
    BOUND,
    FAILED,
    ABORTED,
    EXPIRED;

    public boolean terminal() {
        return this == READY || this == QUARANTINED || this == BOUND || this == FAILED
                || this == ABORTED || this == EXPIRED;
    }

    public boolean acceptsParts() {
        return this == INIT || this == UPLOADING || this == PAUSED;
    }

    public boolean canAbort() {
        return this == INIT || this == UPLOADING || this == PAUSED;
    }
}
