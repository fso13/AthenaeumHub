package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

public final class Chat {

    public enum Type {
        DIRECT, GROUP
    }

    public enum SecurityMode {
        MANAGED, E2EE
    }

    private final UUID id;
    private final UUID workspaceId;
    private final Type type;
    private final SecurityMode securityMode;
    private final String name;
    private final UUID createdBy;
    private final Instant lastMessageAt;

    private Chat(UUID id, UUID workspaceId, Type type, SecurityMode securityMode, String name,
                 UUID createdBy, Instant lastMessageAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.type = Objects.requireNonNull(type, "type");
        this.securityMode = Objects.requireNonNull(securityMode, "securityMode");
        this.name = name;
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
        this.lastMessageAt = lastMessageAt;
    }

    /**
     * Single domain rule for "E2EE supports only 1:1 in E7" (E2EE-SPEC §6.2.8, D-S4).
     * Both the API create path and the onboarding/provisioning path must call it, so no
     * code path can silently create an E2EE GROUP that has no send/fan-out semantics.
     *
     * @throws DomainException 409 {@code E2EE_GROUP_NOT_SUPPORTED}
     */
    public static void requireSupportedType(SecurityMode securityMode, Type type) {
        Objects.requireNonNull(securityMode, "securityMode");
        Objects.requireNonNull(type, "type");
        if (securityMode == SecurityMode.E2EE && type != Type.DIRECT) {
            throw DomainException.conflict(ErrorCode.E2EE_GROUP_NOT_SUPPORTED,
                    "E2EE GROUP chats are not supported in E7", Map.of("type", type.name()));
        }
    }

    public static Chat createManagedGroup(UUID id, UUID workspaceId, UUID createdBy, String name) {
        return createGroup(id, workspaceId, createdBy, name, SecurityMode.MANAGED);
    }

    public static Chat createGroup(UUID id, UUID workspaceId, UUID createdBy, String name,
                                   SecurityMode securityMode) {
        requireSupportedType(securityMode, Type.GROUP);
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("Group chat name must not be blank");
        }
        return new Chat(id, workspaceId, Type.GROUP, securityMode, name.strip(), createdBy, null);
    }

    /** DIRECT has no server-side name; the client derives a display name (D-S4-02). */
    public static Chat createDirect(UUID id, UUID workspaceId, UUID createdBy,
                                    SecurityMode securityMode) {
        requireSupportedType(securityMode, Type.DIRECT);
        return new Chat(id, workspaceId, Type.DIRECT, securityMode, null, createdBy, null);
    }

    public static Chat reconstitute(UUID id, UUID workspaceId, Type type, SecurityMode securityMode,
                                    String name, UUID createdBy, Instant lastMessageAt) {
        return new Chat(id, workspaceId, type, securityMode, name, createdBy, lastMessageAt);
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public Type type() {
        return type;
    }

    public SecurityMode securityMode() {
        return securityMode;
    }

    public String name() {
        return name;
    }

    public UUID createdBy() {
        return createdBy;
    }

    public Instant lastMessageAt() {
        return lastMessageAt;
    }
}
