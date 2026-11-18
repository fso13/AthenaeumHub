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
    private final String description;
    private final UUID createdBy;
    private final Instant lastMessageAt;
    private final Instant createdAt;

    private Chat(UUID id, UUID workspaceId, Type type, SecurityMode securityMode, String name,
                 String description, UUID createdBy, Instant lastMessageAt, Instant createdAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.type = Objects.requireNonNull(type, "type");
        this.securityMode = Objects.requireNonNull(securityMode, "securityMode");
        this.name = name;
        this.description = description;
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
        this.lastMessageAt = lastMessageAt;
        this.createdAt = createdAt;
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
        return new Chat(id, workspaceId, Type.GROUP, securityMode, name.strip(), null,
                createdBy, null, null);
    }

    /**
     * DIRECT has no server-side name at creation; the client derives a display name
     * (D-S4-02). D1-BE3 may later set an explicit server-side override via PATCH.
     */
    public static Chat createDirect(UUID id, UUID workspaceId, UUID createdBy,
                                    SecurityMode securityMode) {
        requireSupportedType(securityMode, Type.DIRECT);
        return new Chat(id, workspaceId, Type.DIRECT, securityMode, null, null, createdBy, null,
                null);
    }

    public static Chat reconstitute(UUID id, UUID workspaceId, Type type, SecurityMode securityMode,
                                    String name, String description, UUID createdBy,
                                    Instant lastMessageAt, Instant createdAt) {
        return new Chat(id, workspaceId, type, securityMode, name, description, createdBy,
                lastMessageAt, createdAt);
    }

    /**
     * Copy with new editable settings. Validation/normalisation is the caller's job (see
     * {@code ChatSettingsPolicy}); the domain keeps the invariant that a DIRECT chat may
     * have no name while a named chat uses a trimmed 1..120 string.
     */
    public Chat withSettings(String name, String description) {
        return new Chat(id, workspaceId, type, securityMode, name, description, createdBy,
                lastMessageAt, createdAt);
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

    public String description() {
        return description;
    }

    public UUID createdBy() {
        return createdBy;
    }

    public Instant lastMessageAt() {
        return lastMessageAt;
    }

    public Instant createdAt() {
        return createdAt;
    }
}
