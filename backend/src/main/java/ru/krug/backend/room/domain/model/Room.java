package ru.krug.backend.room.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * A workspace video room (#105). The room is metadata around a managed GROUP channel:
 * {@code chatId} points at the backing channel that the existing call signalling uses.
 * The domain deliberately stores no call/SFU/media state — only lifecycle.
 */
public final class Room {

    public enum Status {
        ACTIVE, CLOSED
    }

    static final int MAX_NAME_LENGTH = 120;

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final String name;
    private final UUID createdBy;
    private final Instant createdAt;
    private final Instant updatedAt;
    private final Status status;

    private Room(UUID id, UUID workspaceId, UUID chatId, String name, UUID createdBy,
                 Instant createdAt, Instant updatedAt, Status status) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.name = Objects.requireNonNull(name, "name");
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
        this.status = Objects.requireNonNull(status, "status");
    }

    public static Room create(UUID id, UUID workspaceId, UUID chatId, String name,
                              UUID createdBy, Instant at) {
        return new Room(id, workspaceId, chatId, normalizeName(name), createdBy, at, at,
                Status.ACTIVE);
    }

    public static Room reconstitute(UUID id, UUID workspaceId, UUID chatId, String name,
                                    UUID createdBy, Instant createdAt, Instant updatedAt,
                                    Status status) {
        return new Room(id, workspaceId, chatId, name, createdBy, createdAt, updatedAt, status);
    }

    /**
     * A room name is a trimmed 1..120-code-point label. The same label becomes the backing
     * channel name, so the DB CHECK (chat.chats name 1..120) remains a backstop.
     */
    public static String normalizeName(String name) {
        if (name == null || name.isBlank()) {
            throw DomainException.badRequest("name must be 1..120 characters",
                    java.util.Map.of("field", "name", "max_length", MAX_NAME_LENGTH));
        }
        String stripped = name.strip();
        if (stripped.codePointCount(0, stripped.length()) > MAX_NAME_LENGTH) {
            throw DomainException.badRequest("name must be 1..120 characters",
                    java.util.Map.of("field", "name", "max_length", MAX_NAME_LENGTH));
        }
        return stripped;
    }

    public Room rename(String newName, Instant at) {
        return new Room(id, workspaceId, chatId, normalizeName(newName), createdBy, createdAt,
                at, status);
    }

    public Room close(Instant at) {
        return new Room(id, workspaceId, chatId, name, createdBy, createdAt, at, Status.CLOSED);
    }

    /** Join/heartbeat is allowed only while the room is ACTIVE. */
    public void requireActive() {
        if (status != Status.ACTIVE) {
            throw DomainException.conflict(ErrorCode.ROOM_CLOSED,
                    "Room is closed", java.util.Map.of("room_id", id.toString()));
        }
    }

    /**
     * Rename: the creator or a workspace OWNER/ADMIN. A plain member who happens to be in
     * the room cannot rename somebody else's room.
     */
    public boolean canBeEditedBy(UUID actorId, String workspaceRole) {
        return createdBy.equals(actorId) || "OWNER".equals(workspaceRole)
                || "ADMIN".equals(workspaceRole);
    }

    /** Close: the creator or a workspace OWNER (ADMIN alone is not enough). */
    public boolean canBeClosedBy(UUID actorId, String workspaceRole) {
        return createdBy.equals(actorId) || "OWNER".equals(workspaceRole);
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

    public String name() {
        return name;
    }

    public UUID createdBy() {
        return createdBy;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    public Status status() {
        return status;
    }
}
