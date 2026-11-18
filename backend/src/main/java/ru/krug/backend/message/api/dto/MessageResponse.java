package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * OpenAPI {@code MessageCreateResult} (allOf {@code Message} + optional
 * {@code envelope_coverage}). The coverage object is present only for E2EE sends; managed
 * responses keep the exact previous shape.
 */
public record MessageResponse(
        UUID id,
        UUID chatId,
        long seq,
        String type,
        UUID senderId,
        String senderDisplayName,
        String text,
        UUID replyToId,
        java.time.Instant createdAt,
        java.time.Instant editedAt,
        java.time.Instant deletedAt,
        int version,
        UUID clientMessageId,
        Object crypto,
        UUID stickerId,
        @JsonInclude(JsonInclude.Include.NON_NULL) MessageStickerResponse sticker,
        List<AttachmentRefResponse> attachments,
        @JsonInclude(JsonInclude.Include.NON_NULL) EnvelopeCoverageResponse envelopeCoverage) {

    public MessageResponse(UUID id, UUID chatId, long seq, String type, UUID senderId,
                           String senderDisplayName, String text, UUID replyToId,
                           java.time.Instant createdAt, java.time.Instant editedAt,
                           java.time.Instant deletedAt, int version, UUID clientMessageId,
                           Object crypto, UUID stickerId, MessageStickerResponse sticker,
                           List<AttachmentRefResponse> attachments) {
        this(id, chatId, seq, type, senderId, senderDisplayName, text, replyToId, createdAt,
                editedAt, deletedAt, version, clientMessageId, crypto, stickerId, sticker,
                attachments, null);
    }
}
