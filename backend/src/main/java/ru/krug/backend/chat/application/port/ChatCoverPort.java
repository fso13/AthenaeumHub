package ru.krug.backend.chat.application.port;

import java.util.UUID;

/**
 * Cross-context validation of a channel cover (P0-2 / #80). Implemented by the file context.
 *
 * <p>There is deliberately no new upload pipeline: the cover is an existing managed
 * attachment that must belong to the same workspace and the same chat, be an image and pass
 * the AV gate (READY/BOUND + CLEAN/SKIPPED).</p>
 */
public interface ChatCoverPort {

    /**
     * @return the attachment id when it is a valid cover
     * @throws ru.krug.backend.shared.error.DomainException 404 unknown/foreign/other-chat
     *         attachment, 422 {@code CHAT_COVER_INVALID} for a non-image, 409
     *         {@code ATTACHMENT_NOT_READY}, 423 {@code ATTACHMENT_QUARANTINED}.
     */
    UUID requireCoverAttachment(UUID workspaceId, UUID chatId, UUID attachmentId);
}
