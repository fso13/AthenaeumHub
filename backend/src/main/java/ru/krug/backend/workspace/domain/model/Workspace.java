package ru.krug.backend.workspace.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * Workspace aggregate. P0-4 adds a plain-text description and a logo attachment reference;
 * the security mode remains immutable (V16 trigger).
 */
public final class Workspace {

    public static final int MAX_DESCRIPTION = 500;

    public enum SecurityMode {
        MANAGED, E2EE
    }

    public enum Status {
        ACTIVE, SUSPENDED, DELETED
    }

    private final UUID id;
    private final String name;
    private final String slug;
    private final String description;
    private final UUID logoFileId;
    private final SecurityMode securityMode;
    private final Status status;
    private final UUID createdBy;

    private Workspace(UUID id, String name, String slug, String description, UUID logoFileId,
                      SecurityMode securityMode, Status status, UUID createdBy) {
        this.id = Objects.requireNonNull(id, "id");
        this.name = requireText(name, "name");
        if (this.name.length() > 120) {
            throw new IllegalArgumentException("Workspace name must be at most 120 characters");
        }
        this.slug = requireText(slug, "slug");
        this.description = normalizeDescription(description);
        this.logoFileId = logoFileId;
        this.securityMode = Objects.requireNonNull(securityMode, "securityMode");
        this.status = Objects.requireNonNull(status, "status");
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
    }

    public static Workspace createManagedDev(UUID id, String name, String slug, UUID createdBy) {
        return new Workspace(id, name, slug, null, null, SecurityMode.MANAGED, Status.ACTIVE,
                createdBy);
    }

    /** Self-service onboarding; the security mode is immutable for the workspace lifetime. */
    public static Workspace create(UUID id, String name, String slug, SecurityMode securityMode,
                                   UUID createdBy) {
        return new Workspace(id, name, slug, null, null, securityMode, Status.ACTIVE, createdBy);
    }

    public static Workspace reconstitute(UUID id, String name, String slug,
                                         SecurityMode securityMode, Status status,
                                         UUID createdBy) {
        return new Workspace(id, name, slug, null, null, securityMode, status, createdBy);
    }

    public static Workspace reconstitute(UUID id, String name, String slug, String description,
                                         UUID logoFileId, SecurityMode securityMode,
                                         Status status, UUID createdBy) {
        return new Workspace(id, name, slug, description, logoFileId, securityMode, status,
                createdBy);
    }

    /** Partial settings update; presence flags distinguish "keep" from an explicit null. */
    public Workspace withSettings(String newName, String newDescription,
                                  boolean descriptionPresent, UUID newLogoFileId,
                                  boolean logoPresent) {
        return new Workspace(id,
                newName == null ? name : newName,
                slug,
                descriptionPresent ? newDescription : description,
                logoPresent ? newLogoFileId : logoFileId,
                securityMode,
                status,
                createdBy);
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

    public String description() {
        return description;
    }

    public UUID logoFileId() {
        return logoFileId;
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

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Workspace " + field + " must not be blank");
        }
        return value.strip();
    }

    private static String normalizeDescription(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip();
        if (normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > MAX_DESCRIPTION) {
            throw new IllegalArgumentException("Workspace description is too long");
        }
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (Character.isISOControl(character) && character != '\n' && character != '\r'
                    && character != '\t') {
                throw new IllegalArgumentException(
                        "Workspace description contains a control character");
            }
        }
        return normalized;
    }
}
