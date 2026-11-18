package ru.krug.backend.message.application.model;

import java.util.UUID;

/**
 * Attachment projection owned by the message context. The file context implements the port
 * and maps its aggregate into this record, so message application never imports file
 * domain classes.
 */
public record MessageAttachmentView(
        UUID id,
        String filename,
        long sizeBytes,
        String mimeType,
        String scanStatus) {
}
