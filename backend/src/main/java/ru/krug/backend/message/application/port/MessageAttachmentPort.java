package ru.krug.backend.message.application.port;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Cross-context port: binds READY/CLEAN managed attachments to a message and reads them for
 * response/replay models. Implemented by the file context; runs in the caller's transaction.
 */
public interface MessageAttachmentPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 404 unknown/foreign attachment,
     *         403 not the uploader, 409 ATTACHMENT_NOT_READY, 423 ATTACHMENT_QUARANTINED,
     *         422 TOO_MANY_FILES.
     */
    List<MessageAttachmentView> bind(Principal principal, UUID workspaceId, UUID chatId,
                                     UUID messageId, List<UUID> attachmentIds);

    Map<UUID, List<MessageAttachmentView>> findByMessageIds(UUID workspaceId,
                                                            List<UUID> messageIds);

    /**
     * Delete-for-all tombstone: bound attachments stop being downloadable (410
     * ATTACHMENT_DELETED) so clearing the message body cannot leave the media reachable by
     * URL. Idempotent; unbound/foreign rows are never touched.
     */
    void markDeletedForMessage(UUID workspaceId, UUID messageId, Instant deletedAt);
}
