package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * File-side implementation of the message attachment port. Binding happens in the message
 * transaction; quota was already committed at upload complete, so bind never changes used.
 */
@Service
public class MessageAttachmentService implements MessageAttachmentPort {

    private static final int MAX_ATTACHMENTS = 10;

    private final AttachmentRepository attachmentRepository;
    private final UploadRepository uploadRepository;
    private final ClockPort clock;

    public MessageAttachmentService(AttachmentRepository attachmentRepository,
                                    UploadRepository uploadRepository, ClockPort clock) {
        this.attachmentRepository = attachmentRepository;
        this.uploadRepository = uploadRepository;
        this.clock = clock;
    }

    @Override
    @Transactional
    public List<MessageAttachmentView> bind(Principal principal, UUID workspaceId, UUID chatId,
                                            UUID messageId, List<UUID> attachmentIds) {
        if (attachmentIds == null || attachmentIds.isEmpty()) {
            return List.of();
        }
        if (attachmentIds.size() > MAX_ATTACHMENTS) {
            throw DomainException.unprocessable(ErrorCode.TOO_MANY_FILES,
                    "A message can carry at most 10 attachments",
                    Map.of("limit", MAX_ATTACHMENTS, "actual", attachmentIds.size()));
        }
        Set<UUID> unique = new HashSet<>(attachmentIds);
        if (unique.size() != attachmentIds.size()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "attachment_ids must be unique",
                    Map.of("field", "attachment_ids", "reason", "duplicate"));
        }

        Instant now = clock.now();
        List<MessageAttachmentView> bound = new ArrayList<>(attachmentIds.size());
        for (UUID attachmentId : attachmentIds) {
            Attachment attachment = attachmentRepository.findForUpdate(workspaceId, attachmentId)
                    .orElseThrow(UploadNotFoundException::new);
            if (!attachment.isOwnedBy(principal.userId())) {
                throw DomainException.forbidden("Attachment belongs to another user");
            }
            if (!attachment.belongsToChat(chatId)) {
                // Hide a foreign chat's attachment rather than disclosing its existence.
                throw new UploadNotFoundException();
            }
            attachment.assertBindable();
            Attachment stored = attachment.bindTo(messageId, now);
            attachmentRepository.save(stored);
            uploadRepository.findForUpdate(workspaceId, attachment.uploadId())
                    .map(upload -> upload.markBound(now))
                    .ifPresent(uploadRepository::save);
            bound.add(view(stored));
        }
        return bound;
    }

    @Override
    @Transactional(readOnly = true)
    public Map<UUID, List<MessageAttachmentView>> findByMessageIds(UUID workspaceId,
                                                                   List<UUID> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, List<MessageAttachmentView>> result = new LinkedHashMap<>();
        for (Attachment attachment : attachmentRepository.findByMessageIds(workspaceId,
                messageIds)) {
            result.computeIfAbsent(attachment.messageId(), key -> new ArrayList<>())
                    .add(view(attachment));
        }
        return result;
    }

    private static MessageAttachmentView view(Attachment attachment) {
        return new MessageAttachmentView(attachment.id(), attachment.filename(),
                attachment.sizeBytes(), attachment.mimeType(), attachment.scanStatus().name());
    }
}
