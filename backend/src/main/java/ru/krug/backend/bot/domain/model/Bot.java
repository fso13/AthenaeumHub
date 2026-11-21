package ru.krug.backend.bot.domain.model;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;

/**
 * Bot aggregate. The only credential stored is a SHA-256 hash of the one-time bearer token;
 * the aggregate can compare a candidate hash in constant time but cannot recover the token.
 *
 * <p>MVP invariants: a name is 1..80 characters, {@code scopes} is a non-empty subset of
 * {@link BotScope} (only {@code chat.write}), and a bot never belongs to an E2EE chat or has
 * any identity beyond its workspace. The workspace role check is an application concern; the
 * aggregate only enforces its own shape.</p>
 */
public final class Bot {

    public static final int NAME_MAX_LENGTH = 80;
    public static final int TOKEN_HASH_LENGTH = 32;

    private final UUID id;
    private final UUID workspaceId;
    private final String name;
    private final UUID avatarFileId;
    private final byte[] tokenHash;
    private final List<String> scopes;
    private final UUID createdBy;
    private final BotStatus status;
    private final Instant createdAt;
    private final Instant updatedAt;
    private final Instant tokenRotatedAt;

    private Bot(UUID id, UUID workspaceId, String name, UUID avatarFileId, byte[] tokenHash,
                List<String> scopes, UUID createdBy, BotStatus status, Instant createdAt,
                Instant updatedAt, Instant tokenRotatedAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.name = requireName(name);
        this.avatarFileId = avatarFileId;
        this.tokenHash = requireTokenHash(tokenHash);
        this.scopes = List.copyOf(Objects.requireNonNull(scopes, "scopes"));
        if (this.scopes.isEmpty()) {
            throw new IllegalArgumentException("scopes must not be empty");
        }
        this.createdBy = Objects.requireNonNull(createdBy, "createdBy");
        this.status = Objects.requireNonNull(status, "status");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
        this.tokenRotatedAt = tokenRotatedAt;
    }

    public static Bot create(UUID id, UUID workspaceId, String name, UUID avatarFileId,
                             byte[] tokenHash, List<String> scopes, UUID createdBy,
                             Instant now) {
        return new Bot(id, workspaceId, name, avatarFileId, tokenHash,
                BotScope.normalize(scopes), createdBy, BotStatus.ACTIVE, now, now, null);
    }

    public static Bot reconstitute(UUID id, UUID workspaceId, String name, UUID avatarFileId,
                                   byte[] tokenHash, List<String> scopes, UUID createdBy,
                                   BotStatus status, Instant createdAt, Instant updatedAt,
                                   Instant tokenRotatedAt) {
        return new Bot(id, workspaceId, name, avatarFileId, tokenHash, scopes, createdBy,
                status, createdAt, updatedAt, tokenRotatedAt);
    }

    /** Constant-time comparison against the stored hash. A null/short candidate is false. */
    public boolean matchesTokenHash(byte[] candidateHash) {
        return candidateHash != null
                && MessageDigest.isEqual(tokenHash, candidateHash);
    }

    public boolean isActive() {
        return status == BotStatus.ACTIVE;
    }

    public boolean hasScope(BotScope scope) {
        return scope != null && scopes.contains(scope.wire());
    }

    public Bot rename(String value, Instant now) {
        return new Bot(id, workspaceId, value, avatarFileId, tokenHash, scopes, createdBy,
                status, createdAt, now, tokenRotatedAt);
    }

    public Bot changeScopes(List<String> values, Instant now) {
        return new Bot(id, workspaceId, name, avatarFileId, tokenHash,
                BotScope.normalize(values), createdBy, status, createdAt, now, tokenRotatedAt);
    }

    public Bot changeAvatar(UUID fileId, Instant now) {
        return new Bot(id, workspaceId, name, fileId, tokenHash, scopes, createdBy, status,
                createdAt, now, tokenRotatedAt);
    }

    public Bot disable(Instant now) {
        return new Bot(id, workspaceId, name, avatarFileId, tokenHash, scopes, createdBy,
                BotStatus.DISABLED, createdAt, now, tokenRotatedAt);
    }

    public Bot enable(Instant now) {
        return new Bot(id, workspaceId, name, avatarFileId, tokenHash, scopes, createdBy,
                BotStatus.ACTIVE, createdAt, now, tokenRotatedAt);
    }

    /** Replaces the credential hash; the previous token stops working immediately. */
    public Bot rotateToken(byte[] newTokenHash, Instant now) {
        return new Bot(id, workspaceId, name, avatarFileId, newTokenHash, scopes, createdBy,
                status, createdAt, now, now);
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public String name() {
        return name;
    }

    public UUID avatarFileId() {
        return avatarFileId;
    }

    public byte[] tokenHash() {
        return tokenHash.clone();
    }

    public List<String> scopes() {
        return scopes;
    }

    public UUID createdBy() {
        return createdBy;
    }

    public BotStatus status() {
        return status;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    public Instant tokenRotatedAt() {
        return tokenRotatedAt;
    }

    private static String requireName(String value) {
        String name = value == null ? null : value.strip();
        if (name == null || name.isEmpty() || name.length() > NAME_MAX_LENGTH) {
            throw DomainException.badRequest("bot name must be 1..80 characters",
                    Map.of("field", "name", "max_length", NAME_MAX_LENGTH));
        }
        return name;
    }

    private static byte[] requireTokenHash(byte[] value) {
        if (value == null || value.length != TOKEN_HASH_LENGTH) {
            throw new IllegalArgumentException("bot token hash must be 32 bytes");
        }
        return value.clone();
    }
}
