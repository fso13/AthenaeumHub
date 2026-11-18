package ru.krug.backend.realtime.application.service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.realtime.application.model.AttachmentMediaSnapshot;
import ru.krug.backend.realtime.application.model.EphemeralEvent;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.PresenceStatus;
import ru.krug.backend.realtime.application.model.RealtimeEvent;
import ru.krug.backend.realtime.application.model.StickerSnapshot;

/**
 * Builds wire payloads from application models. The map keys are exactly the snake_case
 * names of contracts/openapi.yaml and contracts/ws-protocol.md; map values are never
 * renamed by Jackson, so they are written explicitly here.
 */
public final class RealtimeEventFactory {

    public static final String MESSAGE_CREATED = "message.created";
    public static final String MESSAGE_RECEIPT = "message.receipt";
    public static final String TYPING = "typing";
    public static final String PRESENCE = "presence";

    private RealtimeEventFactory() {
    }

    public static RealtimeEvent messageCreated(MessageSnapshot message) {
        return messageCreated(message, Map.of());
    }

    /**
     * E2EE variant: the payload is device-neutral ({@code crypto:null}); the transport
     * substitutes the envelope of each connection's device from {@code cryptoByDevice}.
     */
    public static RealtimeEvent messageCreated(MessageSnapshot message,
                                               Map<UUID, Object> cryptoByDevice) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("id", message.id());
        payload.put("chat_id", message.chatId());
        payload.put("seq", message.seq());
        payload.put("type", message.type());
        payload.put("sender_id", message.senderId());
        payload.put("sender_display_name", message.senderDisplayName());
        payload.put("text", message.text());
        payload.put("reply_to_id", message.replyToId());
        payload.put("thread_root_id", message.threadRootId());
        payload.put("created_at", message.createdAt());
        payload.put("edited_at", message.editedAt());
        payload.put("deleted_at", message.deletedAt());
        payload.put("version", message.version());
        payload.put("client_message_id", message.clientMessageId());
        payload.put("crypto", message.crypto());
        payload.put("sticker_id", message.stickerId());
        if (message.sticker() != null) {
            payload.put("sticker", sticker(message.sticker()));
        }
        payload.put("attachments", message.attachments().stream().map(attachment -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", attachment.id());
            item.put("filename", attachment.filename());
            item.put("size_bytes", attachment.sizeBytes());
            item.put("mime_type", attachment.mimeType());
            item.put("scan_status", attachment.scanStatus());
            item.put("media", media(attachment.media()));
            return item;
        }).toList());
        // The message id is the stable event id: replay and live delivery of the same fact
        // must dedupe to one event on the client.
        return new RealtimeEvent(message.id(), MESSAGE_CREATED, message.workspaceId(),
                message.chatId(), message.seq(), message.createdAt(), payload, cryptoByDevice);
    }

    private static Map<String, Object> media(AttachmentMediaSnapshot media) {
        if (media == null) {
            return null;
        }
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("kind", media.kind());
        item.put("duration_ms", media.durationMs());
        item.put("width", media.width());
        item.put("height", media.height());
        item.put("title", media.title());
        item.put("artist", media.artist());
        item.put("album", media.album());
        item.put("year", media.year());
        item.put("genre", media.genre());
        item.put("artwork_url", media.artworkUrl());
        item.put("metadata_source", media.metadataSource());
        return item;
    }

    private static Map<String, Object> sticker(StickerSnapshot sticker) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", sticker.id());
        item.put("pack_id", sticker.packId());
        item.put("alt", sticker.alt());
        item.put("url", sticker.url());
        item.put("favorite", sticker.favorite());
        return item;
    }

    public static RealtimeEvent messageReceipt(UUID workspaceId, UUID chatId, UUID userId,
                                               long lastReadSeq, Instant ts) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("user_id", userId);
        payload.put("last_read_seq", lastReadSeq);
        return new RealtimeEvent(UUID.randomUUID(), MESSAGE_RECEIPT, workspaceId, chatId,
                lastReadSeq, ts, payload);
    }

    public static EphemeralEvent typing(UUID workspaceId, UUID chatId, UUID userId,
                                        Instant expiresAt, Instant ts) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("user_id", userId);
        payload.put("expires_at", expiresAt);
        return new EphemeralEvent(TYPING, workspaceId, chatId, userId, ts, payload);
    }

    public static EphemeralEvent presence(UUID workspaceId, UUID chatId, UUID userId,
                                          PresenceStatus status, Instant ts) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("user_id", userId);
        payload.put("status", status.name());
        payload.put("last_seen_at", ts);
        return new EphemeralEvent(PRESENCE, workspaceId, chatId, userId, ts, payload);
    }
}
