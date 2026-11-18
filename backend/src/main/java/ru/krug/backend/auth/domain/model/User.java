package ru.krug.backend.auth.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * auth aggregate root. Pure domain: no persistence/transport annotations.
 */
public final class User {

    public enum Status {
        ACTIVE, SUSPENDED, DELETED
    }

    private final UUID id;
    private final String email;
    private final DisplayName displayName;
    private final Status status;
    private final boolean platformAdmin;

    private User(UUID id, String email, DisplayName displayName, Status status,
                 boolean platformAdmin) {
        this.id = Objects.requireNonNull(id, "id");
        this.email = Objects.requireNonNull(email, "email");
        this.displayName = Objects.requireNonNull(displayName, "displayName");
        this.status = Objects.requireNonNull(status, "status");
        this.platformAdmin = platformAdmin;
    }

    public static User createDev(UUID id, String email, DisplayName displayName) {
        return createDev(id, email, displayName, false);
    }

    public static User createDev(UUID id, String email, DisplayName displayName,
                                 boolean platformAdmin) {
        return new User(id, email, displayName, Status.ACTIVE, platformAdmin);
    }

    /**
     * First login through an OIDC provider (JIT provisioning). The caller has already
     * normalised the email; passwords never reach this aggregate.
     */
    public static User provision(UUID id, String email, DisplayName displayName) {
        return provision(id, email, displayName, false);
    }

    public static User provision(UUID id, String email, DisplayName displayName,
                                 boolean platformAdmin) {
        if (email == null || email.isBlank()) {
            throw new IllegalArgumentException("Provisioned user email must not be blank");
        }
        return new User(id, email.strip(), displayName, Status.ACTIVE, platformAdmin);
    }

    public static User reconstitute(UUID id, String email, DisplayName displayName, Status status) {
        return reconstitute(id, email, displayName, status, false);
    }

    public static User reconstitute(UUID id, String email, DisplayName displayName, Status status,
                                    boolean platformAdmin) {
        return new User(id, email, displayName, status, platformAdmin);
    }

    public UUID id() {
        return id;
    }

    public String email() {
        return email;
    }

    public DisplayName displayName() {
        return displayName;
    }

    public Status status() {
        return status;
    }

    /** Platform-wide administrator flag (auth.users.is_platform_admin, R-03). */
    public boolean isPlatformAdmin() {
        return platformAdmin;
    }

    public boolean isActive() {
        return status == Status.ACTIVE;
    }
}
