package ru.krug.backend.message.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * message aggregate root. Text is kept in the domain; encryption is a persistence concern.
 * A STICKER message references exactly one sticker and has no body. An E2EE message has
 * neither a body nor any plaintext metadata: its content lives in opaque envelopes.
 */
public final class Message {

    public enum Type {
        TEXT, STICKER, SYSTEM, POLL, TASK
    }

    /**
     * Who authored the row. {@code USER} is the default for every existing message.
     * {@code BOT} rows carry a {@code botId} and no user/device identity — a bot can never
     * impersonate a member.
     */
    public enum SenderType {
        USER, BOT
    }

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final long seq;
    private final UUID senderId;
    private final UUID senderDeviceId;
    private final SenderType senderType;
    /** Author bot for {@link SenderType#BOT}; null for every user message. */
    private final UUID botId;
    private final String senderDisplayName;
    private final Type type;
    private final CryptoScheme cryptoScheme;
    private final MessageBody body;
    private final UUID stickerId;
    /** Referenced poll; non-null iff {@link Type#POLL}. No body is stored for it. */
    private final UUID pollId;
    /** Referenced task; non-null iff {@link Type#TASK}. No body is stored for it. */
    private final UUID taskId;
    private final UUID replyToId;
    /** Root of a flat thread; null for a main-feed message. Depth is always one. */
    private final UUID threadRootId;
    private final UUID clientMessageId;
    /** Explicit mentioned users (#83); empty for E2EE and messages without mentions. */
    private final List<UUID> mentions;
    /** Whether the message used @all (#83); always false for E2EE. */
    private final boolean mentionAll;
    private final Instant createdAt;
    private final Instant editedAt;
    private final Instant deletedAt;
    private final int version;

    private Message(UUID id, UUID workspaceId, UUID chatId, long seq, UUID senderId,
                    UUID senderDeviceId, String senderDisplayName, Type type,
                    CryptoScheme cryptoScheme, MessageBody body, UUID stickerId,
                    UUID pollId, UUID taskId, UUID replyToId, UUID threadRootId,
                    UUID clientMessageId, Instant createdAt, Instant editedAt,
                    Instant deletedAt, int version) {
        this(id, workspaceId, chatId, seq, senderId, senderDeviceId, senderDisplayName, type,
                cryptoScheme, body, stickerId, pollId, taskId, replyToId, threadRootId,
                clientMessageId, List.of(), false, createdAt, editedAt, deletedAt, version,
                SenderType.USER, null);
    }

    private Message(UUID id, UUID workspaceId, UUID chatId, long seq, UUID senderId,
                    UUID senderDeviceId, String senderDisplayName, Type type,
                    CryptoScheme cryptoScheme, MessageBody body, UUID stickerId,
                    UUID pollId, UUID taskId, UUID replyToId, UUID threadRootId,
                    UUID clientMessageId, List<UUID> mentions, boolean mentionAll,
                    Instant createdAt, Instant editedAt, Instant deletedAt, int version) {
        this(id, workspaceId, chatId, seq, senderId, senderDeviceId, senderDisplayName, type,
                cryptoScheme, body, stickerId, pollId, taskId, replyToId, threadRootId,
                clientMessageId, mentions, mentionAll, createdAt, editedAt, deletedAt, version,
                SenderType.USER, null);
    }

    private Message(UUID id, UUID workspaceId, UUID chatId, long seq, UUID senderId,
                    UUID senderDeviceId, String senderDisplayName, Type type,
                    CryptoScheme cryptoScheme, MessageBody body, UUID stickerId,
                    UUID pollId, UUID taskId, UUID replyToId, UUID threadRootId,
                    UUID clientMessageId, List<UUID> mentions, boolean mentionAll,
                    Instant createdAt, Instant editedAt, Instant deletedAt, int version,
                    SenderType senderType, UUID botId) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        if (seq <= 0) {
            throw new IllegalArgumentException("seq must be > 0");
        }
        this.seq = seq;
        this.senderId = senderId;
        this.senderDeviceId = senderDeviceId;
        this.senderType = Objects.requireNonNull(senderType, "senderType");
        this.botId = botId;
        this.senderDisplayName = senderDisplayName;
        this.type = Objects.requireNonNull(type, "type");
        this.cryptoScheme = Objects.requireNonNull(cryptoScheme, "cryptoScheme");
        this.body = body;
        this.stickerId = stickerId;
        this.pollId = pollId;
        this.taskId = taskId;
        this.replyToId = replyToId;
        if (threadRootId != null && threadRootId.equals(id)) {
            throw new IllegalArgumentException("message cannot be its own thread root");
        }
        this.threadRootId = threadRootId;
        this.clientMessageId = clientMessageId;
        this.mentions = mentions == null ? List.of() : List.copyOf(mentions);
        this.mentionAll = mentionAll;
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
                senderDisplayName, Type.TEXT, CryptoScheme.MANAGED, body, null, null, null,
                replyToId, threadRootId, clientMessageId, createdAt, null, null, 1);
    }

    /**
     * Managed TEXT message with mention metadata (#83). Mentions are never allowed on E2EE
     * (the send path rejects them and the aggregate re-checks it).
     */
    public static Message createText(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                     MessageBody body, UUID replyToId, UUID threadRootId,
                                     UUID clientMessageId, List<UUID> mentions,
                                     boolean mentionAll, Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.TEXT, CryptoScheme.MANAGED, body, null, null, null,
                replyToId, threadRootId, clientMessageId, mentions, mentionAll, createdAt,
                null, null, 1);
    }

    /**
     * #96: server-authored bot message. There is no user/device identity, no reply/thread,
     * no sticker/plugin payload and no mention metadata. The bot name is snapshotted into
     * {@code senderDisplayName} so renaming or disabling the bot never rewrites history.
     */
    public static Message createBotText(UUID id, UUID workspaceId, UUID chatId, long seq,
                                        UUID botId, String botDisplayName, MessageBody body,
                                        Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, null, null, botDisplayName,
                Type.TEXT, CryptoScheme.MANAGED, body, null, null, null, null, null, null,
                List.of(), false, createdAt, null, null, 1, SenderType.BOT, botId);
    }

    public static Message createSticker(UUID id, UUID workspaceId, UUID chatId, long seq,
                                        UUID senderId, UUID senderDeviceId,
                                        String senderDisplayName, UUID stickerId, UUID replyToId,
                                        UUID clientMessageId, Instant createdAt) {        return createSticker(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, stickerId, replyToId, null, clientMessageId, createdAt);
    }

    public static Message createSticker(UUID id, UUID workspaceId, UUID chatId, long seq,
                                        UUID senderId, UUID senderDeviceId,
                                        String senderDisplayName, UUID stickerId, UUID replyToId,
                                        UUID threadRootId, UUID clientMessageId,
                                        Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.STICKER, CryptoScheme.MANAGED, null, stickerId, null,
                null, replyToId, threadRootId, clientMessageId, createdAt, null, null, 1);
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
                null, null, null, clientMessageId, createdAt, null, null, 1);
    }

    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID replyToId, UUID clientMessageId,
                                       Instant createdAt, Instant editedAt, Instant deletedAt,
                                       int version) {
        return reconstitute(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, null, null, replyToId,
                null, clientMessageId, createdAt, editedAt, deletedAt, version);
    }

    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID replyToId, UUID threadRootId,
                                       UUID clientMessageId, Instant createdAt, Instant editedAt,
                                       Instant deletedAt, int version) {
        return reconstitute(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, null, null, replyToId,
                threadRootId, clientMessageId, createdAt, editedAt, deletedAt, version);
    }

    /**
     * Server-created poll message: no body, no client_message_id, no thread/reply metadata.
     * The poll id is the only content reference; the question/options are read through the
     * embedded poll projection.
     */
    public static Message createPoll(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId,
                                     String senderDisplayName, UUID pollId, Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.POLL, CryptoScheme.MANAGED, null, null, pollId, null,
                null, null, null, createdAt, null, null, 1);
    }

    /** Server-created task message; see {@link #createPoll}. */
    public static Message createTask(UUID id, UUID workspaceId, UUID chatId, long seq,
                                     UUID senderId, UUID senderDeviceId,
                                     String senderDisplayName, UUID taskId, Instant createdAt) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, Type.TASK, CryptoScheme.MANAGED, null, null, null, taskId,
                null, null, null, createdAt, null, null, 1);
    }

    /**
     * Full reconstitution used by persistence; the shorter overloads are kept for callers
     * that never carry a plugin reference (TEXT/STICKER/SYSTEM/E2EE).
     */
    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID pollId, UUID taskId, UUID replyToId,
                                       UUID threadRootId, UUID clientMessageId, Instant createdAt,
                                       Instant editedAt, Instant deletedAt, int version) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, pollId, taskId,
                replyToId, threadRootId, clientMessageId, createdAt, editedAt, deletedAt,
                version);
    }

    /** Persistence reconstitution including #83 mention metadata. */
    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID pollId, UUID taskId, UUID replyToId,
                                       UUID threadRootId, UUID clientMessageId, List<UUID> mentions,
                                       boolean mentionAll, Instant createdAt, Instant editedAt,
                                       Instant deletedAt, int version) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, pollId, taskId,
                replyToId, threadRootId, clientMessageId, mentions, mentionAll, createdAt,
                editedAt, deletedAt, version);
    }

    /** Full persistence reconstitution including the #96 sender type and bot author. */
    public static Message reconstitute(UUID id, UUID workspaceId, UUID chatId, long seq,
                                       UUID senderId, UUID senderDeviceId, String senderDisplayName,
                                       Type type, CryptoScheme cryptoScheme, MessageBody body,
                                       UUID stickerId, UUID pollId, UUID taskId, UUID replyToId,
                                       UUID threadRootId, UUID clientMessageId, List<UUID> mentions,
                                       boolean mentionAll, Instant createdAt, Instant editedAt,
                                       Instant deletedAt, int version, SenderType senderType,
                                       UUID botId) {
        return new Message(id, workspaceId, chatId, seq, senderId, senderDeviceId,
                senderDisplayName, type, cryptoScheme, body, stickerId, pollId, taskId,
                replyToId, threadRootId, clientMessageId, mentions, mentionAll, createdAt,
                editedAt, deletedAt, version, senderType, botId);
    }

    private void requireTypeInvariants() {
        if (senderType == SenderType.BOT) {
            if (botId == null) {
                throw new IllegalArgumentException("BOT message requires a bot id");
            }
            if (type != Type.TEXT) {
                throw new IllegalArgumentException("BOT message must be type TEXT");
            }
            if (cryptoScheme != CryptoScheme.MANAGED) {
                throw new IllegalArgumentException("BOT message must be MANAGED");
            }
            if (senderId != null || senderDeviceId != null) {
                throw new IllegalArgumentException(
                        "BOT message must not carry a user or device identity");
            }
            if (body == null) {
                throw new IllegalArgumentException("BOT message requires a body");
            }
            if (replyToId != null || threadRootId != null || stickerId != null
                    || pollId != null || taskId != null) {
                throw new IllegalArgumentException(
                        "BOT message must not carry reply/thread/plugin/sticker metadata");
            }
            if (!mentions.isEmpty() || mentionAll) {
                throw new IllegalArgumentException("BOT message must not carry mentions");
            }
        } else if (botId != null) {
            throw new IllegalArgumentException("botId is only allowed on a BOT message");
        }
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
            if (!mentions.isEmpty() || mentionAll) {
                throw new IllegalArgumentException(
                        "E2EE message must not carry mention metadata");
            }
            if (senderId == null || senderDeviceId == null) {
                throw new IllegalArgumentException("E2EE message requires sender and device");
            }
        }
        if (type == Type.TEXT && senderId == null && senderType != SenderType.BOT) {
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
        if (type == Type.POLL || type == Type.TASK) {
            if (senderId == null) {
                throw new IllegalArgumentException("plugin message requires a sender");
            }
            if (body != null) {
                throw new IllegalArgumentException("plugin message must not have a body");
            }
            if (stickerId != null) {
                throw new IllegalArgumentException("plugin message must not have a sticker");
            }
            if (cryptoScheme != CryptoScheme.MANAGED) {
                throw new IllegalArgumentException("plugin message must be MANAGED");
            }
            if (replyToId != null || threadRootId != null) {
                throw new IllegalArgumentException(
                        "plugin message must not be a reply or a thread root");
            }
            if (type == Type.POLL ? pollId == null || taskId != null
                    : taskId == null || pollId != null) {
                throw new IllegalArgumentException(
                        "POLL requires pollId only; TASK requires taskId only");
            }
        } else if (pollId != null || taskId != null) {
            throw new IllegalArgumentException(
                    "pollId/taskId are only allowed on POLL/TASK messages");
        }
    }

    public boolean isPluginMessage() {
        return type == Type.POLL || type == Type.TASK;
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

    public SenderType senderType() {
        return senderType;
    }

    public UUID botId() {
        return botId;
    }

    public boolean isBotMessage() {
        return senderType == SenderType.BOT;
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

    public UUID pollId() {
        return pollId;
    }

    public UUID taskId() {
        return taskId;
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

    /** Explicit mentioned user ids (#83); never populated for E2EE. */
    public List<UUID> mentions() {
        return mentions;
    }

    public boolean mentionAll() {
        return mentionAll;
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
