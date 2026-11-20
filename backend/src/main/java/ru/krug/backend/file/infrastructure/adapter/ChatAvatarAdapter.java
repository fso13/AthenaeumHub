package ru.krug.backend.file.infrastructure.adapter;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatAvatarPort;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Channel avatar/icon over the existing managed-attachment pipeline.
 *
 * <p>No new upload endpoint: the caller uploads through the regular file flow and references
 * the resulting id. Validation is identical to the channel cover (same workspace, same chat,
 * image, READY/BOUND + CLEAN/SKIPPED, fail-closed AV) and is shared through
 * {@link ChatImageAttachmentRules}; only the 422 code differs ({@code CHAT_AVATAR_INVALID}).
 * The download returns a short-lived presigned object URL, so no storage key ever leaks into
 * the API.</p>
 */
@Component
public class ChatAvatarAdapter implements ChatAvatarPort {

    private final AttachmentRepository attachments;
    private final ObjectStoragePort storage;
    private final FileSettingsPort settings;

    public ChatAvatarAdapter(AttachmentRepository attachments, ObjectStoragePort storage,
                             FileSettingsPort settings) {
        this.attachments = attachments;
        this.storage = storage;
        this.settings = settings;
    }

    @Override
    public UUID requireAvatarAttachment(UUID workspaceId, UUID chatId, UUID attachmentId) {
        Attachment attachment = resolve(workspaceId, chatId, attachmentId)
                .orElseThrow(() -> DomainException.notFound("Attachment not found"));
        ChatImageAttachmentRules.requireChatImage(attachment, ErrorCode.CHAT_AVATAR_INVALID,
                "file_id", "avatar");
        return attachment.id();
    }

    @Override
    public Optional<AvatarDownload> download(UUID workspaceId, UUID chatId, UUID attachmentId) {
        Attachment attachment = resolve(workspaceId, chatId, attachmentId).orElse(null);
        if (attachment == null) {
            return Optional.empty();
        }
        ChatImageAttachmentRules.requireChatImage(attachment, ErrorCode.CHAT_AVATAR_INVALID,
                "file_id", "avatar");
        ObjectStoragePort.PresignedUrl url = storage.presignGet(attachment.objectKey(),
                settings.downloadTtl(), attachment.filename(), attachment.mimeType());
        Instant expiresAt = url.expiresAt();
        return Optional.of(new AvatarDownload(url.url(),
                expiresAt == null ? Instant.now().plus(settings.downloadTtl()) : expiresAt));
    }

    private Optional<Attachment> resolve(UUID workspaceId, UUID chatId, UUID attachmentId) {
        return ChatImageAttachmentRules.findChatAttachment(attachments, workspaceId, chatId,
                attachmentId);
    }
}
