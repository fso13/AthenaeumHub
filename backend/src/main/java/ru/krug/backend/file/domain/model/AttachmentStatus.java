package ru.krug.backend.file.domain.model;

/** Attachment state independent of the AV verdict. */
public enum AttachmentStatus {
    READY,
    BOUND,
    QUARANTINED,
    DELETED,
    FAILED;

    public boolean downloadable() {
        return this == READY || this == BOUND;
    }
}
