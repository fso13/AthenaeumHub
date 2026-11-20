package ru.krug.backend.file.domain.model;

/**
 * Provenance of a managed attachment.
 *
 * <p>{@code UPLOAD} is the regular multipart upload pipeline: the object is stored by
 * {@code complete}, starts as {@code SCANNING}/{@code PENDING} and is promoted only after a
 * malware scan. {@code DIRECT_IMAGE} is the trusted, in-request image pipeline of
 * {@code POST /media/images}: only static PNG/JPEG/WebP bytes that passed the magic-byte and
 * header parser are accepted, no generic file content can use it, and the row is created as
 * {@code READY}/{@code SKIPPED}. Feature validation still treats both sources through the
 * same image/AV gate; the source only widens which attachment a workspace logo may point at
 * (caller-owned direct images) and keeps direct images out of upload GC/quota accounting.
 */
public enum AttachmentSource {
    UPLOAD,
    DIRECT_IMAGE,
    /**
     * #83 workspace-scoped ("global") file. It uses the regular upload session + AV pipeline
     * (unlike {@code DIRECT_IMAGE}), but has no chat until it is attached to a message.
     */
    WORKSPACE
}
