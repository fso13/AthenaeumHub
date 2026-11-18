package ru.krug.backend.workspace.domain.model;

import java.util.Objects;
import java.util.UUID;

public final class Workspace {

    public enum SecurityMode {
        MANAGED, E2EE
    }

    public enum Status {
        ACTIVE, SUSPENDED, DELETED
    }

    private final UUID id;
    private final String name;
    private final String slug;
    private final SecurityMode securityMode;
    private final Status status;
    private final UUID createdBy;

    private Workspace(UUID id, String name, String slug, SecurityMode securityMode, Status status,
                      UUID createdBy) {
        this.id = Objects.requireNonNull(id, "id");
        this.name = requireText(name, "name");
        this.slug = requireText(slug, "slug");
        this.securityMode = Objects.requireNonNull(securityMode, "securityMode");
        this.status = Objects.requireNonNull(status, "status");
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
    }

    public static Workspace createManagedDev(UUID id, String name, String slug, UUID createdBy) {
        return new Workspace(id, name, slug, SecurityMode.MANAGED, Status.ACTIVE, createdBy);
    }

    /** Self-service onboarding; the security mode is immutable for the workspace lifetime. */
    public static Workspace create(UUID id, String name, String slug, SecurityMode securityMode,
                                   UUID createdBy) {
        return new Workspace(id, name, slug, securityMode, Status.ACTIVE, createdBy);
    }

    public static Workspace reconstitute(UUID id, String name, String slug,
                                         SecurityMode securityMode, Status status,
                                         UUID createdBy) {
        return new Workspace(id, name, slug, securityMode, status, createdBy);
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Workspace " + field + " must not be blank");
        }
        return value.strip();
    }

    public UUID id() {
        return id;
    }

    public String name() {
        return name;
    }

    public String slug() {
        return slug;
    }

    public SecurityMode securityMode() {
        return securityMode;
    }

    public Status status() {
        return status;
    }

    public UUID createdBy() {
        return createdBy;
    }
}
