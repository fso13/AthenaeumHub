package ru.krug.backend.message.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
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

    @Column(name = "poll_id")
    private UUID pollId;

    @Column(name = "task_id")
    private UUID taskId;

    @Column(name = "reply_to_id")
    private UUID replyToId;

    @Column(name = "thread_root_id")
    private UUID threadRootId;

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

    /** #83: explicit mentioned user ids, serialized as a jsonb array of uuid strings. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "mentions", columnDefinition = "jsonb", nullable = false)
    private List<String> mentions;

    /** #83: @all marker. Always false for E2EE. */
    @Column(name = "mention_all", nullable = false)
    private boolean mentionAll;

    protected MessageEntity() {
    }

    private MessageEntity(UUID id, UUID workspaceId, UUID chatId, Long seq, UUID senderId,
                          UUID senderDeviceId, String senderDisplayName, String type,
                          String cryptoScheme, byte[] bodyCiphertext, Map<String, Object> contentMeta,
                          UUID clientMessageId, UUID stickerId, UUID pollId, UUID taskId,
                          UUID replyToId, UUID threadRootId, Instant createdAt, Instant editedAt,
                          Instant deletedAt, UUID deletedBy, Integer version) {
        this(id, workspaceId, chatId, seq, senderId, senderDeviceId, senderDisplayName, type,
                cryptoScheme, bodyCiphertext, contentMeta, clientMessageId, stickerId, pollId,
                taskId, replyToId, threadRootId, createdAt, editedAt, deletedAt, deletedBy,
                version, null, false);
    }

    private MessageEntity(UUID id, UUID workspaceId, UUID chatId, Long seq, UUID senderId,
                          UUID senderDeviceId, String senderDisplayName, String type,
                          String cryptoScheme, byte[] bodyCiphertext, Map<String, Object> contentMeta,
                          UUID clientMessageId, UUID stickerId, UUID pollId, UUID taskId,
                          UUID replyToId, UUID threadRootId, Instant createdAt, Instant editedAt,
                          Instant deletedAt, UUID deletedBy, Integer version,
                          List<String> mentions, boolean mentionAll) {
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
        this.pollId = pollId;
        this.taskId = taskId;
        this.replyToId = replyToId;
        this.threadRootId = threadRootId;
        this.createdAt = createdAt;
        this.editedAt = editedAt;
        this.deletedAt = deletedAt;
        this.deletedBy = deletedBy;
        this.version = version;
        this.mentions = mentions == null ? List.of() : List.copyOf(mentions);
        this.mentionAll = mentionAll;
    }

    public static MessageEntity create(UUID id, UUID workspaceId, UUID chatId, Long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       String type, String cryptoScheme, byte[] bodyCiphertext,
                                       Map<String, Object> contentMeta, UUID clientMessageId,
                                       UUID stickerId, UUID pollId, UUID taskId, UUID replyToId,
                                       UUID threadRootId, Instant createdAt, Integer version) {
        return create(id, workspaceId, chatId, seq, senderId, senderDeviceId, senderDisplayName,
                type, cryptoScheme, bodyCiphertext, contentMeta, clientMessageId, stickerId,
                pollId, taskId, replyToId, threadRootId, List.of(), false, createdAt, version);
    }

    /** #83: create with mention metadata (explicit ids + @all marker). */
    public static MessageEntity create(UUID id, UUID workspaceId, UUID chatId, Long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       String type, String cryptoScheme, byte[] bodyCiphertext,
                                       Map<String, Object> contentMeta, UUID clientMessageId,
                                       UUID stickerId, UUID pollId, UUID taskId, UUID replyToId,
                                       UUID threadRootId, List<UUID> mentions, boolean mentionAll,
                                       Instant createdAt, Integer version) {
        List<String> serialized = mentions == null ? List.of()
                : mentions.stream().map(UUID::toString).toList();
        return new MessageEntity(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, bodyCiphertext, contentMeta,
                clientMessageId, stickerId, pollId, taskId, replyToId, threadRootId, createdAt,
                null, null, null, version, serialized, mentionAll);
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

    public UUID getPollId() {
        return pollId;
    }

    public UUID getTaskId() {
        return taskId;
    }

    public UUID getReplyToId() {
        return replyToId;
    }

    public UUID getThreadRootId() {
        return threadRootId;
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

    public List<String> getMentions() {
        return mentions;
    }

    public boolean isMentionAll() {
        return mentionAll;
    }
}
