package ru.krug.backend.message.application.model;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Application input, built by the API from its request DTO. TEXT may omit text when it
 * carries attachments; STICKER requires exactly one sticker_id and no text/attachments.
 * {@code threadRootId} turns the message into a depth-one reply; it is rejected in E2EE
 * chats. {@code envelopes} is the raw E2EE array: it is parsed and validated by the
 * application layer, never by the controller, and the server never decrypts it.
 */
public record MessageCreateInput(
        UUID clientMessageId,
        String type,
        String text,
        UUID stickerId,
        UUID replyToId,
        UUID threadRootId,
        List<UUID> attachmentIds,
        JsonNode envelopes,
        List<UUID> mentions,
        boolean mentionAll) {

    public MessageCreateInput {
        attachmentIds = attachmentIds == null ? List.of() : List.copyOf(attachmentIds);
        mentions = mentions == null ? List.of() : List.copyOf(mentions);
    }

    /** Pre-mentions constructor kept for callers/tests that never carry mention metadata. */
    public MessageCreateInput(UUID clientMessageId, String type, String text, UUID stickerId,
                              UUID replyToId, UUID threadRootId, List<UUID> attachmentIds,
                              JsonNode envelopes) {
        this(clientMessageId, type, text, stickerId, replyToId, threadRootId, attachmentIds,
                envelopes, List.of(), false);
    }

    public MessageCreateInput(UUID clientMessageId, String type, String text, UUID stickerId,
                              UUID replyToId, List<UUID> attachmentIds) {
        this(clientMessageId, type, text, stickerId, replyToId, null, attachmentIds, null);
    }

    /** #83: mention metadata present, either explicit ids or the @all marker. */
    public boolean hasMentions() {
        return mentionAll || !mentions.isEmpty();
    }

    public boolean hasText() {
        return text != null && !text.isEmpty();
    }

    public boolean hasAttachments() {
        return !attachmentIds.isEmpty();
    }

    public boolean hasSticker() {
        return stickerId != null;
    }

    /** The {@code envelopes} field is present, even when it is an empty array. */
    public boolean envelopesPresent() {
        return envelopes != null && !envelopes.isNull();
    }

    public boolean isSticker() {
        return "STICKER".equals(type);
    }
}
