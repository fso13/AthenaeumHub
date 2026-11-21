package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.ThreadSummary;
import ru.krug.backend.sticker.application.model.StickerRefView;

/**
 * Application-level result/read model. The API maps this to a response DTO, so controllers
 * never import domain classes. {@code cryptoScheme} stays internal (it is not part of the
 * OpenAPI {@code Message}); {@code crypto} is the envelope for the requesting device only.
 * {@code threadSummary} is attached to thread roots only and is never present for E2EE.
 * {@code reactions} is an aggregated, caller-relative projection of message_reactions.
 * {@code mentions}/{@code mentionAll} are the #83 mention metadata: explicit ids and the @all
 * marker, never present for E2EE or a delete-for-all tombstone. #96 adds the sender type and
 * the author bot id; a BOT row has no user/device sender.
 */
public record MessageView(
        UUID id,
        UUID chatId,
        long seq,
        String type,
        String cryptoScheme,
        UUID senderId,
        String senderDisplayName,
        String senderType,
        UUID botId,
        String text,
        UUID replyToId,
        UUID threadRootId,
        ThreadSummaryView threadSummary,
        Instant createdAt,
        Instant editedAt,
        Instant deletedAt,
        int version,
        UUID clientMessageId,
        Object crypto,
        UUID stickerId,
        MessageStickerView sticker,
        List<MessageAttachmentView> attachments,
        List<ReactionSummaryView> reactions,
        MessagePluginContent pluginContent,
        List<UUID> mentions,
        boolean mentionAll) {

    public MessageView {
        senderType = senderType == null ? "USER" : senderType;
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
        reactions = reactions == null ? List.of() : List.copyOf(reactions);
        // A tombstone and every E2EE message never carry mention metadata, even if a legacy
        // row or a direct SQL writer left values behind.
        if (deletedAt != null || "E2EE_PAIRWISE".equals(cryptoScheme)) {
            mentions = List.of();
            mentionAll = false;
        } else {
            mentions = mentions == null ? List.of() : List.copyOf(mentions);
        }
    }

    public static MessageView from(Message message) {
        return new MessageView(message.id(), message.chatId(), message.seq(),
                message.type().name(), message.cryptoScheme().name(), message.senderId(),
                message.senderDisplayName(), message.senderType().name(), message.botId(),
                message.body() == null ? null : message.body().value(), message.replyToId(),
                message.threadRootId(), null, message.createdAt(), message.editedAt(),
                message.deletedAt(), message.version(), message.clientMessageId(), null,
                message.stickerId(), null, List.of(), List.of(),
                MessagePluginContent.ids(message.pollId(), message.taskId()),
                message.mentions(), message.mentionAll());
    }

    public boolean isE2ee() {
        return "E2EE_PAIRWISE".equals(cryptoScheme);
    }

    public boolean isBot() {
        return "BOT".equals(senderType);
    }

    public MessageView withAttachments(List<MessageAttachmentView> values) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, crypto,
                stickerId, sticker, values == null ? List.of() : values, reactions,
                pluginContent, mentions, mentionAll);
    }

    public MessageView withSticker(StickerRefView value) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, crypto,
                stickerId, value == null ? null : MessageStickerView.from(value), attachments,
                reactions, pluginContent, mentions, mentionAll);
    }

    /** Attaches the envelope of the requesting device (E2EE) or clears it (managed). */
    public MessageView withCrypto(Object value) {
        // A tombstone never carries an envelope: delete-for-all purges E2EE envelopes and
        // this guard keeps the response safe even if a legacy row still has one.
        if (deletedAt != null) {
            return this;
        }
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, value,
                stickerId, sticker, attachments, reactions, pluginContent, mentions, mentionAll);
    }

    /** Server-computed summary for a thread root; null for replies and empty threads. */
    public MessageView withThreadSummary(ThreadSummary value) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                value == null ? null : ThreadSummaryView.from(value), createdAt, editedAt,
                deletedAt, version, clientMessageId, crypto, stickerId, sticker, attachments,
                reactions, pluginContent, mentions, mentionAll);
    }

    /** Aggregated reactions for this message, already caller-relative. */
    public MessageView withReactions(List<ReactionSummaryView> values) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, crypto,
                stickerId, sticker, attachments, values == null ? List.of() : values,
                pluginContent, mentions, mentionAll);
    }

    /**
     * Attaches the viewer-relative embedded poll/task. A message without a plugin reference
     * keeps {@code null} (the ids are still read from {@link #pluginContent()}), so TEXT,
     * STICKER and SYSTEM responses never grow a plugin object.
     */
    public MessageView withPluginContent(EmbeddedPollView poll, EmbeddedTaskView task) {
        if (pluginContent == null
                || (pluginContent.pollId() == null && pluginContent.taskId() == null)) {
            return this;
        }
        MessagePluginContent content = pluginContent;
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, crypto,
                stickerId, sticker, attachments, reactions, content.withPoll(poll).withTask(task),
                mentions, mentionAll);
    }

    /** #83 mention metadata, used by the create/replay response and by edit events. */
    public MessageView withMentions(List<UUID> values, boolean all) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, text, replyToId, threadRootId,
                threadSummary, createdAt, editedAt, deletedAt, version, clientMessageId, crypto,
                stickerId, sticker, attachments, reactions, pluginContent, values, all);
    }

    /**
     * Delete-for-all projection: content and content-derived metadata must not be returned
     * even if a row was cleared only partially (legacy/direct SQL). The row, seq, sender type
     * and timestamps remain so the client can render a tombstone (and the BOT badge) in place.
     */
    public MessageView asTombstone() {
        if (deletedAt == null) {
            return this;
        }
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId,
                senderDisplayName, senderType, botId, null, replyToId, threadRootId, null,
                createdAt, editedAt, deletedAt, version, clientMessageId, null, null, null,
                List.of(), List.of(), null, List.of(), false);
    }
}
