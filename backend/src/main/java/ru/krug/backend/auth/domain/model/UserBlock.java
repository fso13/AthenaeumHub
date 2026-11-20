package ru.krug.backend.auth.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One entry of the caller's own block list (#79). Identity-scoped, not tenant-scoped:
 * blocks follow the user, exactly like {@code auth.users} itself. Carries no email or
 * display name.
 */
public record UserBlock(UUID blockedId, Instant createdAt) {

    public UserBlock {
        Objects.requireNonNull(blockedId, "blockedId");
        Objects.requireNonNull(createdAt, "createdAt");
    }
}
