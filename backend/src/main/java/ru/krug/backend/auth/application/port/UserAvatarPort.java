package ru.krug.backend.auth.application.port;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Cross-context validation of a profile avatar (P0-4 / #82). Implemented by the file
 * context; there is no new upload pipeline. The attachment must be owned by the caller,
 * be an image and pass the AV gate (READY/BOUND + CLEAN/SKIPPED).
 *
 * <p>Implementations activate the narrow {@code file-resolve} worker role to locate an
 * attachment id without a workspace claim; the caller must re-activate its tenant RLS
 * context after the call before touching its own tables.</p>
 */
public interface UserAvatarPort {

    /** @return the attachment id when it is a valid avatar. */
    UUID requireAvatar(UUID userId, UUID attachmentId);

    /** Presigned download for the stored avatar; empty for a missing/deleted attachment. */
    Optional<AvatarDownload> download(UUID attachmentId);

    record AvatarDownload(String url, Instant expiresAt) {
    }
}
