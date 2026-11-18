package ru.krug.backend.message.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * message aggregate root. Text is kept in the domain; encryption is a persistence concern.
 * A STICKER message references exactly one sticker and has no body. An E2EE message has
 * neither a body nor any plaintext metadata: its content lives in opaque envelopes.
 */
public final class Message {

    public enum Type {
        TEXT, STICKER, SYSTEM
    }

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final long seq;
    private final UUID senderId;
    private final UUID senderDeviceId;
    private final String senderDisplayName;
    private final Type type;
    private final CryptoScheme cryptoScheme;
    private final MessageBody body;
    private final UUID stickerId;
    private final UUID replyToId;
    /** Root of a flat thread; null for a main-feed message. Depth is always one. */
    private final UUID threadRootId;
    private final UUID clientMessageId;
    private final Instant createdAt;
    private final Instant editedAt;
    private final Instant deletedAt;
    private final int version;

    private Message(UUID id, UUID workspaceId, UUID chatId, long seq, UUID senderId,
                    UUID senderDeviceId, String senderDisplayName, Type type,
                    CryptoScheme cryptoScheme, MessageBody body, UUID stickerId,
                    UUID replyToId, UUID threadRootId, UUID clientMessageId, Instant createdAt,
                    Instant editedAt, Instant deletedAt, int version) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        if (seq <= 0) {
            throw new IllegalArgumentException("seq must be > 0");
        }
        this.seq = seq;
        this.senderId = senderId;
        this.senderDeviceId = senderDeviceId;
        this.senderDisplayName = senderDisplayName;
        this.type = Objects.requireNonNull(type, "type");
        this.cryptoScheme = Objects.requireNonNull(cryptoScheme, "cryptoScheme");
        this.body = body;
        this.stickerId = stickerId;
        this.replyToId = replyToId;
        if (threadRootId != null && threadRootId.equals(id)) {
            throw new IllegalArgumentException("message cannot be its own thread root");
        }
        this.threadRootId = threadRootId;
        this.clientMessageId = clientMessageId;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.editedAt = editedAt;
        this.deletedAt = deletedAt;
        this.version = version;
        requireTypeInvariants();
    }

    public static Message createText(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                     MessageBody body, UUID replyToId, UUID clientMessageId,
                                     Instant createdAt) {
        return createText(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, body, replyToId, null, clientMessageId, createdAt);
    }

    public static Message createText(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                     MessageBody body, UUID replyToId, UUID threadRootId,
                                     UUID clientMessageId, Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.TEXT, CryptoScheme.MANAGED, body, null, replyToId,
                threadRootId, clientMessageId, createdAt, null, null, 1);
    }

    public static Message createSticker(UUID id, UUID workspaceId, UUID chatId, long seq,
                                        UUID senderId, UUID senderDeviceId,
                                        String senderDisplayName, UUID stickerId, UUID replyToId,
                                        UUID clientMessageId, Instant createdAt) {
        return createSticker(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, stickerId, replyToId, null, clientMessageId, createdAt);
    }

    public static Message createSticker(UUID id, UUID workspaceId, UUID chatId, long seq,
                                        UUID senderId, UUID senderDeviceId,
                                        String senderDisplayName, UUID stickerId, UUID replyToId,
                                        UUID threadRootId, UUID clientMessageId,
                                        Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.STICKER, CryptoScheme.MANAGED, null, stickerId,
                replyToId, threadRootId, clientMessageId, createdAt, null, null, 1);
    }

    /**
     * E2EE message: no body, no sticker, no reply target — content is only in envelopes.
     * Reply metadata is carried inside the encrypted inner payload (E2EE-SPEC P1-F).
     */
    public static Message createE2ee(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId,
                                     String senderDisplayName, UUID clientMessageId,
                                     Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.TEXT, CryptoScheme.E2EE_PAIRWISE, null, null, null,
                null, clientMessageId, createdAt, null, null, 1);
    }

    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID replyToId, UUID clientMessageId,
                                       Instant createdAt, Instant editedAt, Instant deletedAt,
                                       int version) {
        return reconstitute(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, replyToId, null,
                clientMessageId, createdAt, editedAt, deletedAt, version);
    }

    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID replyToId, UUID threadRootId,
                                       UUID clientMessageId, Instant createdAt, Instant editedAt,
                                       Instant deletedAt, int version) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, replyToId, threadRootId,
                clientMessageId, createdAt, editedAt, deletedAt, version);
    }

    private void requireTypeInvariants() {
        if (cryptoScheme == CryptoScheme.E2EE_PAIRWISE) {
            if (type != Type.TEXT) {
                throw new IllegalArgumentException("E2EE message must be type TEXT");
            }
            if (body != null) {
                throw new IllegalArgumentException("E2EE message must not have a body");
            }
            if (stickerId != null) {
                throw new IllegalArgumentException("E2EE message must not have a sticker");
            }
            if (replyToId != null) {
                throw new IllegalArgumentException("E2EE message must not have reply_to_id");
            }
            if (threadRootId != null) {
                throw new IllegalArgumentException("E2EE message must not have thread_root_id");
            }
            if (senderId == null || senderDeviceId == null) {
                throw new IllegalArgumentException("E2EE message requires sender and device");
            }
        }
        if (type == Type.TEXT && senderId == null) {
            throw new IllegalArgumentException("TEXT message requires a sender");
        }
        if (type == Type.STICKER) {
            if (senderId == null) {
                throw new IllegalArgumentException("STICKER message requires a sender");
            }
            if (stickerId == null) {
                throw new IllegalArgumentException("STICKER message requires a sticker");
            }
            if (body != null) {
                throw new IllegalArgumentException("STICKER message must not have a body");
            }
        } else if (stickerId != null) {
            throw new IllegalArgumentException("stickerId is only allowed on STICKER messages");
        }
        if (type == Type.SYSTEM && body != null) {
            throw new IllegalArgumentException("SYSTEM message must not have a body");
        }
    }

    public boolean isE2ee() {
        return cryptoScheme == CryptoScheme.E2EE_PAIRWISE;
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public long seq() {
        return seq;
    }

    public UUID senderId() {
        return senderId;
    }

    public UUID senderDeviceId() {
        return senderDeviceId;
    }

    public String senderDisplayName() {
        return senderDisplayName;
    }

    public Type type() {
        return type;
    }

    public CryptoScheme cryptoScheme() {
        return cryptoScheme;
    }

    public MessageBody body() {
        return body;
    }

    public UUID stickerId() {
        return stickerId;
    }

    public UUID replyToId() {
        return replyToId;
    }

    public UUID threadRootId() {
        return threadRootId;
    }

    public UUID clientMessageId() {
        return clientMessageId;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant editedAt() {
        return editedAt;
    }

    public Instant deletedAt() {
        return deletedAt;
    }

    public int version() {
        return version;
    }
}
