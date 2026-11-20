package ru.krug.backend.chat.application.port;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Cross-context validation and delivery of a channel avatar/icon ({@code POST/DELETE/GET
 * /chats/{chatId}/avatar}). Implemented by the file context.
 *
 * <p>There is deliberately no new upload pipeline: the avatar is an existing managed
 * attachment of the same workspace and the same chat that is an image and passed the AV gate
 * (READY/BOUND + CLEAN/SKIPPED) — exactly the cover rules. A guessed id from another chat,
 * another workspace or a deleted row is a hidden 404.</p>
 */
public interface ChatAvatarPort {

    /**
     * @return the attachment id when it is a valid channel avatar
     * @throws ru.krug.backend.shared.error.DomainException 404 unknown/foreign/other-chat
     *         attachment, 422 {@code CHAT_AVATAR_INVALID} for a non-image, 409
     *         {@code ATTACHMENT_NOT_READY}, 423 {@code ATTACHMENT_QUARANTINED}.
     */
    UUID requireAvatarAttachment(UUID workspaceId, UUID chatId, UUID attachmentId);

    /**
     * Presigned download of a stored avatar. Empty when the attachment row is gone or no
     * longer belongs to this chat; a non-image or non-downloadable attachment still fails
     * closed (422/409/423).
     */
    Optional<AvatarDownload> download(UUID workspaceId, UUID chatId, UUID attachmentId);

    record AvatarDownload(String url, Instant expiresAt) {
    }
}
