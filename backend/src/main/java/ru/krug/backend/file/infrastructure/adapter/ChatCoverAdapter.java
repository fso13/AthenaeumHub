package ru.krug.backend.file.infrastructure.adapter;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatCoverPort;
import ru.krug.backend.file.domain.exception.AttachmentNotReadyException;
import ru.krug.backend.file.domain.exception.AttachmentQuarantinedException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Validates a channel cover against the existing managed-attachment pipeline (P0-2 / #80).
 * No new upload endpoint: the caller uploads through the regular file flow and references the
 * resulting id.
 *
 * <p>Rules: same workspace and same chat (a guessed id from another chat is a hidden 404),
 * image only ({@code media.kind=IMAGE} or an {@code image/*} MIME), not deleted, and AV is
 * fail-closed — PENDING is {@code 409 ATTACHMENT_NOT_READY}, INFECTED/FAILED is
 * {@code 423 ATTACHMENT_QUARANTINED}. READY and BOUND attachments are accepted.</p>
 */
@Component
public class ChatCoverAdapter implements ChatCoverPort {

    private final AttachmentRepository attachments;

    public ChatCoverAdapter(AttachmentRepository attachments) {
        this.attachments = attachments;
    }

    @Override
    public UUID requireCoverAttachment(UUID workspaceId, UUID chatId, UUID attachmentId) {
        Attachment attachment = attachments.findById(workspaceId, attachmentId)
                .filter(candidate -> candidate.chatId().equals(chatId))
                .filter(candidate -> candidate.deletedAt() == null)
                .orElseThrow(() -> DomainException.notFound("Attachment not found"));
        if (!isImage(attachment)) {
            throw DomainException.unprocessable(ErrorCode.CHAT_COVER_INVALID,
                    "A cover must be an image attachment",
                    Map.of("field", "file_id", "reason", "image_required"));
        }
        if (attachment.scanStatus().quarantined()
                || !attachment.isDownloadable()) {
            if (attachment.scanStatus().quarantined()) {
                throw new AttachmentQuarantinedException(attachment.scanStatus().name());
            }
            throw new AttachmentNotReadyException(attachment.status().name(),
                    attachment.scanStatus().name());
        }
        return attachment.id();
    }

    private static boolean isImage(Attachment attachment) {
        if (attachment.media() != null && attachment.media().kind() == MediaKind.IMAGE) {
            return true;
        }
        String mime = attachment.mimeType();
        return mime != null && mime.toLowerCase(Locale.ROOT).startsWith("image/");
    }
}
