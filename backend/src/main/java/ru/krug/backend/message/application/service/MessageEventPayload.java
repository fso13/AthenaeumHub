package ru.krug.backend.message.application.service;

import java.util.LinkedHashMap;
import java.util.Map;

import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.domain.event.MessageCreatedEvent;

/**
 * Outbox payload for {@code message.created}. Metadata only: no plaintext is ever added
 * here beyond what the API already returns for a managed message; E2EE bodies live in
 * envelopes and are not part of the outbox. #95 adds poll/task ids so downstream consumers
 * can locate the embedded entity.
 */
public final class MessageEventPayload {

    private MessageEventPayload() {
    }

    public static Map<String, Object> of(MessageCreatedEvent event, MessageView view) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("message_id", event.messageId());
        payload.put("chat_id", event.chatId());
        payload.put("seq", event.seq());
        payload.put("sender_id", event.senderId());
        payload.put("type", view.type());
        payload.put("thread_root_id", view.threadRootId());
        payload.put("sticker_id", view.stickerId());
        if (view.sticker() != null) {
            payload.put("sticker", Map.of(
                    "id", view.sticker().id(),
                    "pack_id", view.sticker().packId(),
                    "alt", view.sticker().alt(),
                    "url", view.sticker().url(),
                    "favorite", view.sticker().favorite()));
        }
        if (view.pluginContent() != null) {
            payload.put("poll_id", view.pluginContent().pollId());
            payload.put("task_id", view.pluginContent().taskId());
        }
        payload.put("created_at", event.createdAt().toString());
        payload.put("size_bytes", event.sizeBytes());
        payload.put("attachments", view.attachments().stream().map(attachment -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", attachment.id());
            item.put("filename", attachment.filename());
            item.put("size_bytes", attachment.sizeBytes());
            item.put("mime_type", attachment.mimeType());
            item.put("scan_status", attachment.scanStatus());
            item.put("media", mediaMap(attachment));
            return item;
        }).toList());
        return payload;
    }

    private static Map<String, Object> mediaMap(MessageAttachmentView attachment) {
        var media = attachment.media();
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
}
