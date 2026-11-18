package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import ru.krug.backend.shared.api.CanonicalUuidDeserializer;

/**
 * OpenAPI {@code MessageCreate}; type=TEXT or type=STICKER; E2EE uses envelopes[]. UUID
 * fields are canonicalized explicitly (E2EE-REVIEW-07 P2-06), so an upper-case
 * {@code client_message_id} on the wire always becomes the same lower-case UUID used for
 * the response and the idempotency fingerprint.
 */
public record MessageCreateRequest(
        @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID clientMessageId,
        String type,
        String text,
        @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID stickerId,
        @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID replyToId,
        @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID threadRootId,
        @JsonDeserialize(contentUsing = CanonicalUuidDeserializer.class)
        List<UUID> attachmentIds,
        JsonNode envelopes) {
}
