package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * OpenAPI {@code MessageCreateResult} (allOf {@code Message} + optional
 * {@code envelope_coverage}). The coverage object is present only for E2EE sends; managed
 * responses keep the exact previous shape. {@code thread_summary} is always emitted
 * (usually null) so a client never has to distinguish "absent" from "no replies".
 */
public record MessageResponse(
        UUID id,
        UUID chatId,
        long seq,
        String type,
        UUID senderId,
        String senderDisplayName,
        /** #96: USER or BOT; a BOT message carries bot_id and no user/device sender. */
        String senderType,
        @JsonInclude(JsonInclude.Include.NON_NULL) UUID botId,
        String text,
        UUID replyToId,
        UUID threadRootId,
        java.time.Instant createdAt,
        java.time.Instant editedAt,
        java.time.Instant deletedAt,
        int version,
        UUID clientMessageId,
        Object crypto,
        UUID stickerId,
        @JsonInclude(JsonInclude.Include.NON_NULL) MessageStickerResponse sticker,
        List<AttachmentRefResponse> attachments,
        List<ReactionSummaryResponse> reactions,
        ThreadSummaryResponse threadSummary,
        @JsonInclude(JsonInclude.Include.NON_NULL) EnvelopeCoverageResponse envelopeCoverage,
        @JsonInclude(JsonInclude.Include.NON_NULL) UUID pollId,
        @JsonInclude(JsonInclude.Include.NON_NULL) MessagePollResponse poll,
        @JsonInclude(JsonInclude.Include.NON_NULL) UUID taskId,
        @JsonInclude(JsonInclude.Include.NON_NULL) MessageTaskResponse task,
        /** #83: explicit mentioned user ids; empty for E2EE, tombstones and no mentions. */
        List<UUID> mentions,
        /** #83: @all marker; always false for E2EE and tombstones. */
        boolean mentionAll) {
}
