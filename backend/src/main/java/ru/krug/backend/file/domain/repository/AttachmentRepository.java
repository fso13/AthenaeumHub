package ru.krug.backend.file.domain.repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.model.Attachment;

public interface AttachmentRepository {

    void save(Attachment attachment);

    Optional<Attachment> findById(UUID workspaceId, UUID attachmentId);

    Optional<Attachment> findForUpdate(UUID workspaceId, UUID attachmentId);

    Optional<Attachment> findForUpdateById(UUID attachmentId);

    Optional<Attachment> findByUploadId(UUID uploadId);

    List<Attachment> findByMessageIds(UUID workspaceId, Collection<UUID> messageIds);

    List<Attachment> findUnboundReadyBefore(Instant cutoff, int limit);

    /** Worker-role lookup used only to bind an attachment id to its tenant before RLS. */
    Optional<Attachment> findByIdForResolve(UUID attachmentId);
}
