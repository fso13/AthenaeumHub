package ru.krug.backend.realtime.application.service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
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
    public static final String MESSAGE_UPDATED = "message.updated";
    public static final String MESSAGE_DELETED = "message.deleted";
    public static final String MESSAGE_REACTION_CHANGED = "message.reaction.changed";
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
        return new RealtimeEvent(message.id(), MESSAGE_CREATED, message.workspaceId(),
                message.chatId(), message.seq(), message.createdAt(),
                messagePayload(message), cryptoByDevice);
    }

    /** Edit fan-out: same {@code Message} payload as created, with the new version/edited_at. */
    public static RealtimeEvent messageUpdated(MessageSnapshot message) {
        Instant ts = message.editedAt() == null ? message.createdAt() : message.editedAt();
        UUID eventId = stableId("message.updated:" + message.id() + ":" + message.version());
        return new RealtimeEvent(eventId, MESSAGE_UPDATED, message.workspaceId(),
                message.chatId(), message.seq(), ts, messagePayload(message));
    }

    /**
     * Delete-for-all tombstone. Delete-for-me is deliberately not fanned out: only the
     * caller's own reads change, and broadcasting it would hide the message for everyone.
     */
    public static RealtimeEvent messageDeleted(UUID workspaceId, UUID chatId, UUID messageId,
                                               long seq, Instant deletedAt, UUID deletedBy,
                                               String scope) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("message_id", messageId);
        payload.put("chat_id", chatId);
        payload.put("seq", seq);
        payload.put("deleted_at", deletedAt);
        payload.put("deleted_by", deletedBy);
        payload.put("scope", scope);
        UUID eventId = stableId("message.deleted:" + messageId + ":" + scope + ":" + deletedAt);
        return new RealtimeEvent(eventId, MESSAGE_DELETED, workspaceId, chatId, seq, deletedAt,
                payload);
    }

    public static RealtimeEvent messageReactionChanged(UUID workspaceId, UUID chatId,
                                                       UUID messageId, long seq, UUID userId,
                                                       String emoji, String action, long count,
                                                       Instant ts) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("message_id", messageId);
        payload.put("chat_id", chatId);
        payload.put("seq", seq);
        payload.put("user_id", userId);
        payload.put("emoji", emoji);
        payload.put("action", action);
        payload.put("count", count);
        // The fact is (message, user, emoji, action, resulting count); a repeated
        // idempotent POST/DELETE must dedupe to the same event even though its wall clock
        // timestamp differs.
        UUID eventId = stableId("message.reaction.changed:" + messageId + ":" + userId + ":"
                + emoji + ":" + action + ":" + count);
        return new RealtimeEvent(eventId, MESSAGE_REACTION_CHANGED, workspaceId, chatId, seq,
                ts, payload);
    }

    private static Map<String, Object> messagePayload(MessageSnapshot message) {
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
        // #95: POLL/TASK timeline projection. Embedded content is viewer-relative for live
        // frames and may be null on a tombstone; ids stay null for every other type.
        payload.put("poll_id", message.pluginContent() == null
                ? null : message.pluginContent().pollId());
        payload.put("poll", message.pluginContent() == null || message.pluginContent().poll() == null
                ? null : poll(message.pluginContent().poll()));
        payload.put("task_id", message.pluginContent() == null
                ? null : message.pluginContent().taskId());
        payload.put("task", message.pluginContent() == null || message.pluginContent().task() == null
                ? null : task(message.pluginContent().task()));
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
        payload.put("reactions", message.reactions().stream().map(reaction -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("emoji", reaction.emoji());
            item.put("count", reaction.count());
            item.put("me", reaction.me());
            return item;
        }).toList());
        return payload;
    }

    private static UUID stableId(String fact) {
        return UUID.nameUUIDFromBytes(fact.getBytes(StandardCharsets.UTF_8));
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

    private static Map<String, Object> poll(EmbeddedPollView poll) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", poll.id());
        item.put("question", poll.question());
        item.put("options", poll.options().stream().map(option -> {
            Map<String, Object> optionItem = new LinkedHashMap<>();
            optionItem.put("id", option.id());
            optionItem.put("text", option.text());
            optionItem.put("position", option.position());
            optionItem.put("votes", option.votes());
            return optionItem;
        }).toList());
        item.put("creator_id", poll.creatorId());
        item.put("closed", poll.closed());
        item.put("closed_at", poll.closedAt());
        item.put("created_at", poll.createdAt());
        item.put("my_option_id", poll.myOptionId());
        item.put("total_votes", poll.totalVotes());
        return item;
    }

    private static Map<String, Object> task(EmbeddedTaskView task) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", task.id());
        item.put("title", task.title());
        item.put("creator_id", task.creatorId());
        item.put("assignee_id", task.assigneeId());
        item.put("due_at", task.dueAt());
        item.put("done", task.done());
        item.put("completed_by", task.completedBy());
        item.put("completed_at", task.completedAt());
        item.put("created_at", task.createdAt());
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
