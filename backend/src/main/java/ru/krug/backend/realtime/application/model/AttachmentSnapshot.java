package ru.krug.backend.realtime.application.model;

import java.util.List;

/** Projection of a managed attachment for WS payloads (matches OpenAPI AttachmentRef). */
public record AttachmentSnapshot(
        java.util.UUID id,
        String filename,
        long sizeBytes,
        String mimeType,
        String scanStatus) {
}
