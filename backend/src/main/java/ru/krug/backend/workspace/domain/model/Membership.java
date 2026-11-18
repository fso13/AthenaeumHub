package ru.krug.backend.workspace.domain.model;

import java.util.Objects;
import java.util.UUID;

public final class Membership {

    public enum Role {
        OWNER, ADMIN, MEMBER, GUEST
    }

    public enum Status {
        INVITED, ACTIVE, REMOVED
    }

    private final UUID workspaceId;
    private final UUID userId;
    private final Role role;
    private final Status status;

    private Membership(UUID workspaceId, UUID userId, Role role, Status status) {
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.role = Objects.requireNonNull(role, "role");
        this.status = Objects.requireNonNull(status, "status");
    }

    public static Membership owner(UUID workspaceId, UUID userId) {
        return new Membership(workspaceId, userId, Role.OWNER, Status.ACTIVE);
    }

    public static Membership reconstitute(UUID workspaceId, UUID userId, Role role, Status status) {
        return new Membership(workspaceId, userId, role, status);
    }

    public boolean isActive() {
        return status == Status.ACTIVE;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID userId() {
        return userId;
    }

    public Role role() {
        return role;
    }

    public Status status() {
        return status;
    }
}
