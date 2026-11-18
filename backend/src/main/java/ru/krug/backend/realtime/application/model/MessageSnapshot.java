package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Read model of a persisted message, shaped like the OpenAPI {@code Message} component.
 * The realtime context owns this model; the history adapter maps message entities into it.
 */
public record MessageSnapshot(
        UUID workspaceId,
        UUID id,
        UUID chatId,
        long seq,
        String type,
        UUID senderId,
        String senderDisplayName,
        String text,
        UUID replyToId,
        UUID threadRootId,
        Instant createdAt,
        Instant editedAt,
        Instant deletedAt,
        int version,
        UUID clientMessageId,
        Object crypto,
        UUID stickerId,
        StickerSnapshot sticker,
        List<AttachmentSnapshot> attachments) {

    public MessageSnapshot {
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
    }

    /** Back-compat constructor for managed snapshots without thread root. */
    public MessageSnapshot(UUID workspaceId, UUID id, UUID chatId, long seq, String type,
                           UUID senderId, String senderDisplayName, String text, UUID replyToId,
                           Instant createdAt, Instant editedAt, Instant deletedAt, int version,
                           UUID stickerId, StickerSnapshot sticker,
                           List<AttachmentSnapshot> attachments) {
        this(workspaceId, id, chatId, seq, type, senderId, senderDisplayName, text, replyToId,
                null, createdAt, editedAt, deletedAt, version, null, null, stickerId, sticker,
                attachments);
    }
}
