package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/**
 * Workspace invite link (P0-4 / #82, #100). The entity deliberately has no token field: the
 * raw token exists only in the create response / invitation email and PostgreSQL stores
 * its SHA-256 hash.
 *
 * <p>An invite with a non-null {@link #email()} is bound to one normalized address and is
 * always single-use; a link invite (email {@code null}) keeps the multi-use semantics.</p>
 */
public final class WorkspaceInvite {

    public enum Status {
        ACTIVE, EXPIRED, EXHAUSTED, REVOKED
    }

    private final UUID id;
    private final UUID workspaceId;
    private final Membership.Role role;
    private final String email;
    private final Integer maxUses;
    private final int usedCount;
    private final Instant expiresAt;
    private final Instant revokedAt;
    private final Instant createdAt;
    private final UUID createdBy;

    private WorkspaceInvite(UUID id, UUID workspaceId, Membership.Role role, String email,
                            Integer maxUses, int usedCount, Instant expiresAt,
                            Instant revokedAt, Instant createdAt, UUID createdBy) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.role = Objects.requireNonNull(role, "role");
        if (role == Membership.Role.OWNER) {
            throw new IllegalArgumentException("An invite link cannot grant OWNER");
        }
        String normalizedEmail = normalizeEmail(email);
        if (normalizedEmail != null) {
            if (normalizedEmail.length() > 254 || !normalizedEmail.contains("@")) {
                throw new IllegalArgumentException("email is invalid");
            }
            if (maxUses == null || maxUses != 1) {
                throw new IllegalArgumentException("An email-bound invite is single-use");
            }
        }
        if (maxUses != null && (maxUses < 1 || maxUses > 1000)) {
            throw new IllegalArgumentException("maxUses must be 1..1000 or null");
        }
        if (usedCount < 0 || (maxUses != null && usedCount > maxUses)) {
            throw new IllegalArgumentException("usedCount is outside 0..maxUses");
        }
        this.email = normalizedEmail;
        this.maxUses = maxUses;
        this.usedCount = usedCount;
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        this.revokedAt = revokedAt;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.createdBy = createdBy;
    }

    /** Link invite (email-less, multi-use). */
    public static WorkspaceInvite create(UUID id, UUID workspaceId, Membership.Role role,
                                         Integer maxUses, Instant expiresAt, Instant createdAt,
                                         UUID createdBy) {
        return create(id, workspaceId, role, maxUses, expiresAt, createdAt, createdBy, null);
    }

    /** #100: an email-bound invite is forced to a single use. */
    public static WorkspaceInvite create(UUID id, UUID workspaceId, Membership.Role role,
                                         Integer maxUses, Instant expiresAt, Instant createdAt,
                                         UUID createdBy, String email) {
        return new WorkspaceInvite(id, workspaceId, role, email, maxUses, 0, expiresAt, null,
                createdAt, createdBy);
    }

    public static WorkspaceInvite reconstitute(UUID id, UUID workspaceId, Membership.Role role,
                                               Integer maxUses, int usedCount, Instant expiresAt,
                                               Instant revokedAt, Instant createdAt,
                                               UUID createdBy) {
        return reconstitute(id, workspaceId, role, maxUses, usedCount, expiresAt, revokedAt,
                createdAt, createdBy, null);
    }

    public static WorkspaceInvite reconstitute(UUID id, UUID workspaceId, Membership.Role role,
                                               Integer maxUses, int usedCount, Instant expiresAt,
                                               Instant revokedAt, Instant createdAt,
                                               UUID createdBy, String email) {
        return new WorkspaceInvite(id, workspaceId, role, email, maxUses, usedCount, expiresAt,
                revokedAt, createdAt, createdBy);
    }

    /** Revocation wins over expiry, expiry over exhaustion. */
    public Status status(Instant now) {
        if (revokedAt != null) {
            return Status.REVOKED;
        }
        if (expiresAt != null && !expiresAt.isAfter(now)) {
            return Status.EXPIRED;
        }
        if (maxUses != null && usedCount >= maxUses) {
            return Status.EXHAUSTED;
        }
        return Status.ACTIVE;
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public Membership.Role role() {
        return role;
    }

    /** Normalized lower-case recipient of a single-use email invite; {@code null} for a link. */
    public String email() {
        return email;
    }

    public boolean isEmailBound() {
        return email != null;
    }

    public Integer maxUses() {
        return maxUses;
    }

    public int usedCount() {
        return usedCount;
    }

    public Instant expiresAt() {
        return expiresAt;
    }

    public Instant revokedAt() {
        return revokedAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public UUID createdBy() {
        return createdBy;
    }

    /** Case-insensitive normalization shared with the persistence/registration path. */
    public static String normalizeEmail(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        return normalized.isEmpty() ? null : normalized;
    }
}
