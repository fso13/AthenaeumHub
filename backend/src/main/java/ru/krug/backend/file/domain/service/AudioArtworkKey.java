package ru.krug.backend.file.domain.service;

import java.util.UUID;

/**
 * Deterministic private object key for a server-extracted audio cover (#97).
 *
 * <p>The key is built exclusively from server-side UUIDs (workspace, attachment), never from a
 * filename, tag value or other client data, so it cannot traverse the bucket namespace. The
 * artwork lives in the same private bucket as the upload and is only reachable through the
 * authenticated {@code GET /attachments/{id}/artwork} endpoint.
 */
public final class AudioArtworkKey {

    private AudioArtworkKey() {
    }

    public static String forAttachment(UUID workspaceId, UUID attachmentId) {
        return "workspaces/" + workspaceId + "/artwork/" + attachmentId;
    }
}
