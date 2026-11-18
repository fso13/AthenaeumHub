package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.sticker.application.model.StickerRefView;

/**
 * Application-level result/read model. The API maps this to a response DTO, so controllers
 * never import domain classes. {@code cryptoScheme} stays internal (it is not part of the
 * OpenAPI {@code Message}); {@code crypto} is the envelope for the requesting device only.
 */
public record MessageView(
        UUID id,
        UUID chatId,
        long seq,
        String type,
        String cryptoScheme,
        UUID senderId,
        String senderDisplayName,
        String text,
        UUID replyToId,
        Instant createdAt,
        Instant editedAt,
        Instant deletedAt,
        int version,
        UUID clientMessageId,
        Object crypto,
        UUID stickerId,
        MessageStickerView sticker,
        List<MessageAttachmentView> attachments) {

    public MessageView {
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
    }

    public static MessageView from(Message message) {
        return new MessageView(message.id(), message.chatId(), message.seq(),
                message.type().name(), message.cryptoScheme().name(), message.senderId(),
                message.senderDisplayName(),
                message.body() == null ? null : message.body().value(), message.replyToId(),
                message.createdAt(), message.editedAt(), message.deletedAt(), message.version(),
                message.clientMessageId(), null, message.stickerId(), null, List.of());
    }

    public boolean isE2ee() {
        return "E2EE_PAIRWISE".equals(cryptoScheme);
    }

    public MessageView withAttachments(List<MessageAttachmentView> values) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId, senderDisplayName,
                text, replyToId, createdAt, editedAt, deletedAt, version, clientMessageId,
                crypto, stickerId, sticker, values == null ? List.of() : values);
    }

    public MessageView withSticker(StickerRefView value) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId, senderDisplayName,
                text, replyToId, createdAt, editedAt, deletedAt, version, clientMessageId,
                crypto, stickerId, value == null ? null : MessageStickerView.from(value),
                attachments);
    }

    /** Attaches the envelope of the requesting device (E2EE) or clears it (managed). */
    public MessageView withCrypto(Object value) {
        return new MessageView(id, chatId, seq, type, cryptoScheme, senderId, senderDisplayName,
                text, replyToId, createdAt, editedAt, deletedAt, version, clientMessageId,
                value, stickerId, sticker, attachments);
    }
}
