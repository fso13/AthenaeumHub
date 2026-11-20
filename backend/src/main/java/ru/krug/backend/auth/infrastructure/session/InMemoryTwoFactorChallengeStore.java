package ru.krug.backend.auth.infrastructure.session;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.model.TwoFactorChallengeMode;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.TwoFactorChallengePort;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Single-node in-memory challenge store. Bounded by the TTL and an entry cap; expired
 * entries are swept lazily. No token or code is ever logged.
 */
@Component
public class InMemoryTwoFactorChallengeStore implements TwoFactorChallengePort {

    private static final int MAX_ENTRIES = 20_000;

    private record Stored(UUID userId, KeycloakIdentity identity, TokenSet tokens, int attempts,
                          Instant expiresAt, TwoFactorChallengeMode mode) {
    }

    private final ConcurrentHashMap<UUID, Stored> challenges = new ConcurrentHashMap<>();
    private final ClockPort clock;
    private final int maxAttempts;

    public InMemoryTwoFactorChallengeStore(ClockPort clock, AuthBffSettings settings) {
        this.clock = clock;
        this.maxAttempts = Math.max(1, settings.twoFactorMaxAttempts());
    }

    @Override
    public UUID store(UUID userId, KeycloakIdentity identity, TokenSet tokens,
                      Instant expiresAt, TwoFactorChallengeMode mode) {
        if (challenges.size() > MAX_ENTRIES) {
            Instant now = clock.now();
            challenges.entrySet().removeIf(entry -> !now.isBefore(entry.getValue().expiresAt()));
        }
        UUID id = UUID.randomUUID();
        challenges.put(id, new Stored(userId, identity, tokens, 0, expiresAt, mode));
        return id;
    }

    @Override
    public Optional<Challenge> find(UUID challengeId) {
        Stored value = challengeId == null ? null : challenges.get(challengeId);
        if (value == null) {
            return Optional.empty();
        }
        if (!clock.now().isBefore(value.expiresAt())) {
            challenges.remove(challengeId, value);
            return Optional.empty();
        }
        return Optional.of(toChallenge(challengeId, value));
    }

    @Override
    public void recordFailure(UUID challengeId) {
        if (challengeId == null) {
            return;
        }
        challenges.computeIfPresent(challengeId, (id, value) -> {
            int attempts = value.attempts() + 1;
            if (attempts >= maxAttempts) {
                return null;
            }
            return new Stored(value.userId(), value.identity(), value.tokens(), attempts,
                    value.expiresAt(), value.mode());
        });
    }

    @Override
    public Optional<Challenge> consume(UUID challengeId) {
        Stored value = challengeId == null ? null : challenges.remove(challengeId);
        if (value == null || !clock.now().isBefore(value.expiresAt())) {
            return Optional.empty();
        }
        return Optional.of(toChallenge(challengeId, value));
    }

    @Override
    public void discard(UUID challengeId) {
        if (challengeId != null) {
            challenges.remove(challengeId);
        }
    }

    private static Challenge toChallenge(UUID id, Stored value) {
        return new Challenge(id, value.userId(), value.identity(), value.tokens(),
                value.attempts(), value.expiresAt(), value.mode());
    }
}
