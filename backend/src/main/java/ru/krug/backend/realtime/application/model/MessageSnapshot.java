package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.application.model.ReactionSummaryView;

/**
 * Read model of a persisted message, shaped like the OpenAPI {@code Message} component.
 * The realtime context owns this model; the history adapter maps message entities into it.
 * {@code reactions} is the caller-relative aggregate; live created events carry an empty
 * list, replay carries the current state.
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
        List<AttachmentSnapshot> attachments,
        List<ReactionSummaryView> reactions) {

    public MessageSnapshot {
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
        reactions = reactions == null ? List.of() : List.copyOf(reactions);
    }

    /** Back-compat constructor for managed snapshots without thread root or reactions. */
    public MessageSnapshot(UUID workspaceId, UUID id, UUID chatId, long seq, String type,
                           UUID senderId, String senderDisplayName, String text, UUID replyToId,
                           Instant createdAt, Instant editedAt, Instant deletedAt, int version,
                           UUID stickerId, StickerSnapshot sticker,
                           List<AttachmentSnapshot> attachments) {
        this(workspaceId, id, chatId, seq, type, senderId, senderDisplayName, text, replyToId,
                null, createdAt, editedAt, deletedAt, version, null, null, stickerId, sticker,
                attachments, List.of());
    }
}
