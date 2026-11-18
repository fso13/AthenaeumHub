package ru.krug.backend.message.infrastructure.persistence;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * JPA persistence model. Encrypted body only; plaintext never reaches this class.
 */
@Entity
@Table(name = "messages", schema = "message")
public class MessageEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "chat_id", nullable = false)
    private UUID chatId;

    @Column(name = "seq", nullable = false)
    private Long seq;

    @Column(name = "sender_id")
    private UUID senderId;

    @Column(name = "sender_device_id")
    private UUID senderDeviceId;

    @Column(name = "sender_display_name")
    private String senderDisplayName;

    @Column(name = "type", nullable = false)
    private String type;

    @Column(name = "crypto_scheme", nullable = false)
    private String cryptoScheme;

    @Column(name = "body_ciphertext", columnDefinition = "bytea")
    private byte[] bodyCiphertext;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "content_meta", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> contentMeta;

    @Column(name = "client_message_id")
    private UUID clientMessageId;

    @Column(name = "sticker_id")
    private UUID stickerId;

    @Column(name = "reply_to_id")
    private UUID replyToId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "edited_at")
    private Instant editedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    @Column(name = "deleted_by")
    private UUID deletedBy;

    @Column(name = "version", nullable = false)
    private Integer version;

    protected MessageEntity() {
    }

    private MessageEntity(UUID id, UUID workspaceId, UUID chatId, Long seq, UUID senderId,
                          UUID senderDeviceId, String senderDisplayName, String type,
                          String cryptoScheme, byte[] bodyCiphertext, Map<String, Object> contentMeta,
                          UUID clientMessageId, UUID stickerId, UUID replyToId, Instant createdAt,
                          Instant editedAt, Instant deletedAt, UUID deletedBy, Integer version) {
        this.id = id;
        this.workspaceId = workspaceId;
        this.chatId = chatId;
        this.seq = seq;
        this.senderId = senderId;
        this.senderDeviceId = senderDeviceId;
        this.senderDisplayName = senderDisplayName;
        this.type = type;
        this.cryptoScheme = cryptoScheme;
        this.bodyCiphertext = bodyCiphertext;
        this.contentMeta = contentMeta;
        this.clientMessageId = clientMessageId;
        this.stickerId = stickerId;
        this.replyToId = replyToId;
        this.createdAt = createdAt;
        this.editedAt = editedAt;
        this.deletedAt = deletedAt;
        this.deletedBy = deletedBy;
        this.version = version;
    }

    public static MessageEntity create(UUID id, UUID workspaceId, UUID chatId, Long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       String type, String cryptoScheme, byte[] bodyCiphertext,
                                       Map<String, Object> contentMeta, UUID clientMessageId,
                                       UUID stickerId, UUID replyToId, Instant createdAt,
                                       Integer version) {
        return new MessageEntity(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, bodyCiphertext, contentMeta,
                clientMessageId, stickerId, replyToId, createdAt, null, null, null, version);
    }

    public UUID getId() {
        return id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public UUID getChatId() {
        return chatId;
    }

    public Long getSeq() {
        return seq;
    }

    public UUID getSenderId() {
        return senderId;
    }

    public UUID getSenderDeviceId() {
        return senderDeviceId;
    }

    public String getSenderDisplayName() {
        return senderDisplayName;
    }

    public String getType() {
        return type;
    }

    public byte[] getBodyCiphertext() {
        return bodyCiphertext;
    }

    public String getCryptoScheme() {
        return cryptoScheme;
    }

    public UUID getClientMessageId() {
        return clientMessageId;
    }

    public UUID getStickerId() {
        return stickerId;
    }

    public UUID getReplyToId() {
        return replyToId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getEditedAt() {
        return editedAt;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    public Integer getVersion() {
        return version;
    }
}
