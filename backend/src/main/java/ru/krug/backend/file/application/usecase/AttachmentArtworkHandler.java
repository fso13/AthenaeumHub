package ru.krug.backend.file.application.usecase;

import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.file.application.model.AttachmentArtworkView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.service.AudioArtworkKey;
import ru.krug.backend.file.domain.service.AudioMetadataParser;
import ru.krug.backend.file.domain.service.ArtworkImages;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Authenticated artwork reader (#97): {@code GET /api/v1/attachments/{id}/artwork}.
 *
 * <p>Visibility mirrors attachment download exactly (chat member, workspace asset member or
 * owner-only for an unbound workspace file), and the AV gate is fail-closed: PENDING answers
 * 409 and a quarantined file 423, so a cover from an unscanned object is never served. The
 * object key is derived only from server-side ids; the caller cannot request an arbitrary
 * object and there is no redirect, URL fetch or other SSRF surface.
 */
@Service
public class AttachmentArtworkHandler {

    private final FileAccessGuard accessGuard;
    private final AttachmentRepository attachmentRepository;
    private final ChatAccessPort chatAccess;
    private final ObjectStoragePort storage;

    public AttachmentArtworkHandler(FileAccessGuard accessGuard,
                                    AttachmentRepository attachmentRepository,
                                    ChatAccessPort chatAccess, ObjectStoragePort storage) {
        this.accessGuard = accessGuard;
        this.attachmentRepository = attachmentRepository;
        this.chatAccess = chatAccess;
        this.storage = storage;
    }

    @Transactional(readOnly = true)
    public AttachmentArtworkView artwork(Principal principal, UUID attachmentId) {
        Principal scoped = accessGuard.activateAttachmentScope(principal, attachmentId);
        Attachment attachment = attachmentRepository
                .findById(scoped.workspaceId(), attachmentId)
                .orElseThrow(UploadNotFoundException::new);
        requireVisible(scoped, attachment);
        if (attachment.media() == null || attachment.media().kind() != MediaKind.AUDIO) {
            throw new UploadNotFoundException();
        }

        String key = AudioArtworkKey.forAttachment(attachment.workspaceId(), attachment.id());
        boolean exists;
        try {
            exists = storage.exists(key);
        } catch (RuntimeException ex) {
            exists = false;
        }
        if (!exists) {
            throw new UploadNotFoundException();
        }
        // AV fail-closed: the stored bytes are served only after the regular download gate.
        attachment.assertDownloadable();
        byte[] content;
        try (InputStream input = storage.open(key)) {
            content = input.readNBytes(AudioMetadataParser.MAX_ARTWORK_BYTES + 1);
        } catch (IOException | RuntimeException ex) {
            throw new UploadNotFoundException();
        }
        if (content.length == 0 || content.length > AudioMetadataParser.MAX_ARTWORK_BYTES) {
            throw new UploadNotFoundException();
        }
        String mimeType = ArtworkImages.sniffMimeType(content);
        if (mimeType == null) {
            throw new UploadNotFoundException();
        }
        return new AttachmentArtworkView(content, mimeType);
    }

    /** Same visibility matrix as {@link AttachmentDownloadHandler}. */
    private void requireVisible(Principal scoped, Attachment attachment) {
        if (attachment.messageId() != null) {
            chatAccess.requireActiveChat(scoped.workspaceId(), attachment.chatId(),
                    scoped.userId());
            return;
        }
        if (attachment.isDirectImage()) {
            if (attachment.chatId() != null) {
                chatAccess.requireActiveChat(scoped.workspaceId(), attachment.chatId(),
                        scoped.userId());
            } else {
                accessGuard.requireWorkspaceAccess(scoped, attachment.workspaceId());
            }
            return;
        }
        if (!attachment.isOwnedBy(scoped.userId())) {
            // Unbound regular/workspace files stay owner-only; existence is not disclosed.
            throw new UploadNotFoundException();
        }
    }
}
