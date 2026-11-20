package ru.krug.backend.file.infrastructure.adapter;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.exception.AttachmentNotReadyException;
import ru.krug.backend.file.domain.exception.AttachmentQuarantinedException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.error.DomainException;

/**
 * Shared validation of a managed attachment used as a channel image (cover and avatar).
 *
 * <p>The rules are intentionally identical for both: the attachment must be in the same
 * workspace and the same chat (tenant RLS plus the explicit chat id filter), not deleted, be
 * an image and pass the AV gate. Keeping the rules in one place prevents the cover and the
 * avatar from drifting apart.</p>
 */
final class ChatImageAttachmentRules {

    private ChatImageAttachmentRules() {
    }

    /** The attachment row of this chat, or empty when unknown/foreign/deleted. */
    static Optional<Attachment> findChatAttachment(AttachmentRepository attachments,
                                                   UUID workspaceId, UUID chatId,
                                                   UUID attachmentId) {
        if (attachmentId == null) {
            return Optional.empty();
        }
        return attachments.findById(workspaceId, attachmentId)
                .filter(candidate -> candidate.belongsToChat(chatId))
                .filter(candidate -> candidate.deletedAt() == null);
    }

    /**
     * Fail-closed image validation: non-image is 422, PENDING is 409, INFECTED/FAILED is 423.
     *
     * @param errorCode semantic 422 code of the calling feature
     * @param field     request field name exposed in {@code details}
     * @param resource  human-readable resource name used in the message
     */
    static Attachment requireChatImage(Attachment attachment, String errorCode, String field,
                                       String resource) {
        if (!isImage(attachment)) {
            throw DomainException.unprocessable(errorCode,
                    "A " + resource + " must be an image attachment",
                    Map.of("field", field, "reason", "image_required"));
        }
        if (attachment.scanStatus().quarantined()) {
            throw new AttachmentQuarantinedException(attachment.scanStatus().name());
        }
        if (!attachment.isDownloadable()) {
            throw new AttachmentNotReadyException(attachment.status().name(),
                    attachment.scanStatus().name());
        }
        return attachment;
    }

    static boolean isImage(Attachment attachment) {
        if (attachment.media() != null && attachment.media().kind() == MediaKind.IMAGE) {
            return true;
        }
        String mime = attachment.mimeType();
        return mime != null && mime.toLowerCase(Locale.ROOT).startsWith("image/");
    }
}
