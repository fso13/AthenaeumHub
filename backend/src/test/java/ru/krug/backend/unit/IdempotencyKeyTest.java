package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.domain.model.IdempotencyKey;

class IdempotencyKeyTest {

    @Test
    void inProgressKeyMatchesHashAndExpiresAfter24h() {
        Instant created = Instant.parse("2026-11-16T09:00:00Z");
        byte[] hash = "hash".getBytes(StandardCharsets.UTF_8);
        IdempotencyKey key = IdempotencyKey.inProgress(UUID.randomUUID(), "scope", "key", hash,
                created);

        assertThat(key.matches(hash)).isTrue();
        assertThat(key.matches("other".getBytes(StandardCharsets.UTF_8))).isFalse();
        assertThat(key.isInProgress()).isTrue();
        assertThat(key.isExpired(created.plusSeconds(23 * 3600))).isFalse();
        assertThat(key.isExpired(created.plusSeconds(25 * 3600))).isTrue();
    }
}
