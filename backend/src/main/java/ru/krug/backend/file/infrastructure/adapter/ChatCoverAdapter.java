package ru.krug.backend.file.infrastructure.adapter;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatCoverPort;
import ru.krug.backend.file.domain.model.Attachment;
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
 * {@code 423 ATTACHMENT_QUARANTINED}. READY and BOUND attachments are accepted. The same
 * rules are shared with the channel avatar ({@link ChatImageAttachmentRules}).</p>
 */
@Component
public class ChatCoverAdapter implements ChatCoverPort {

    private final AttachmentRepository attachments;

    public ChatCoverAdapter(AttachmentRepository attachments) {
        this.attachments = attachments;
    }

    @Override
    public UUID requireCoverAttachment(UUID workspaceId, UUID chatId, UUID attachmentId) {
        Attachment attachment = ChatImageAttachmentRules
                .findChatAttachment(attachments, workspaceId, chatId, attachmentId)
                .orElseThrow(() -> DomainException.notFound("Attachment not found"));
        ChatImageAttachmentRules.requireChatImage(attachment, ErrorCode.CHAT_COVER_INVALID,
                "file_id", "cover");
        return attachment.id();
    }
}
