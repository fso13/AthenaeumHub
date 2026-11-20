package ru.krug.backend.message.infrastructure.persistence;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.message.domain.model.CryptoScheme;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;

/**
 * Explicit domain <-> JPA mapping. Encryption/decryption lives here, not in the domain.
 */
@Component
public class MessagePersistenceMapper {

    private final MessageCipher cipher;

    public MessagePersistenceMapper(MessageCipher cipher) {
        this.cipher = cipher;
    }

    public Message toDomain(MessageEntity entity) {
        String text = entity.getBodyCiphertext() == null ? null
                : cipher.decrypt(entity.getBodyCiphertext(),
                        MessageCipher.aad(entity.getWorkspaceId(), entity.getChatId(),
                                entity.getId()));
        return Message.reconstitute(
                entity.getId(), entity.getWorkspaceId(), entity.getChatId(), entity.getSeq(),
                entity.getSenderId(), entity.getSenderDeviceId(), entity.getSenderDisplayName(),
                Message.Type.valueOf(entity.getType()),
                CryptoScheme.valueOf(entity.getCryptoScheme()),
                text == null ? null : new MessageBody(text), entity.getStickerId(),
                entity.getPollId(), entity.getTaskId(), entity.getReplyToId(),
                entity.getThreadRootId(), entity.getClientMessageId(), mentions(entity),
                entity.isMentionAll(), entity.getCreatedAt(),
                entity.getEditedAt(), entity.getDeletedAt(), entity.getVersion());
    }

    public MessageEntity toEntity(Message message) {
        String aad = MessageCipher.aad(message.workspaceId(), message.chatId(), message.id());
        byte[] ciphertext = message.body() == null ? null
                : cipher.encrypt(message.body().value(), aad);
        Map<String, Object> contentMeta = message.body() == null ? Map.of()
                : Map.of("length", message.body().value().length());
        return MessageEntity.create(
                message.id(), message.workspaceId(), message.chatId(), message.seq(),
                message.senderId(), message.senderDeviceId(), message.senderDisplayName(),
                message.type().name(), message.cryptoScheme().name(), ciphertext, contentMeta,
                message.clientMessageId(), message.stickerId(), message.pollId(),
                message.taskId(), message.replyToId(), message.threadRootId(),
                message.mentions(), message.mentionAll(), message.createdAt(),
                message.version());
    }

    private static List<UUID> mentions(MessageEntity entity) {
        if (entity.getMentions() == null || entity.getMentions().isEmpty()) {
            return List.of();
        }
        return entity.getMentions().stream().map(UUID::fromString).toList();
    }

}
