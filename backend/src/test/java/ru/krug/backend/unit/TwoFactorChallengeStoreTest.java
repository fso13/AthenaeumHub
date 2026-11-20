package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.model.TwoFactorChallengeMode;
import ru.krug.backend.auth.infrastructure.config.AuthBffSettingsAdapter;
import ru.krug.backend.auth.infrastructure.session.InMemoryTwoFactorChallengeStore;
import ru.krug.backend.support.AuthBffTestData;
import ru.krug.backend.support.MutableClock;

/** #91: challenge mode, TTL, single-use and the attempt budget of the in-memory store. */
class TwoFactorChallengeStoreTest {

    private static final Instant NOW = Instant.parse("2026-03-01T10:00:00Z");
    private static final KeycloakIdentity IDENTITY =
            new KeycloakIdentity("sub-1", "user@krug.test", true, "user", "User");
    private static final TokenSet TOKENS = new TokenSet("access", "refresh", 900, "Bearer");

    private final MutableClock clock = new MutableClock(NOW);
    private final InMemoryTwoFactorChallengeStore store = new InMemoryTwoFactorChallengeStore(
            clock, new AuthBffSettingsAdapter(AuthBffTestData.properties()));

    @Test
    void storesTheChallengeModeAndIsSingleUse() {
        UUID userId = UUID.randomUUID();
        UUID id = store.store(userId, IDENTITY, TOKENS, NOW.plusSeconds(300),
                TwoFactorChallengeMode.ENROLL);

        var found = store.find(id).orElseThrow();
        assertThat(found.mode()).isEqualTo(TwoFactorChallengeMode.ENROLL);
        assertThat(found.userId()).isEqualTo(userId);
        assertThat(found.toString()).doesNotContain("access", "refresh");

        assertThat(store.consume(id)).isPresent();
        assertThat(store.find(id)).isEmpty();
        assertThat(store.consume(id)).isEmpty();
        assertThat(store.consume(null)).isEmpty();
    }

    @Test
    void expiredChallengeIsRemovedAndAnsweredAsEmpty() {
        UUID id = store.store(UUID.randomUUID(), IDENTITY, TOKENS, NOW.plusSeconds(300),
                TwoFactorChallengeMode.TOTP);
        clock.advanceSeconds(301);

        assertThat(store.find(id)).isEmpty();
        assertThat(store.consume(id)).isEmpty();
    }

    @Test
    void attemptBudgetDiscardsTheChallenge() {
        UUID id = store.store(UUID.randomUUID(), IDENTITY, TOKENS, NOW.plusSeconds(300),
                TwoFactorChallengeMode.TOTP);
        for (int attempt = 0; attempt < 4; attempt++) {
            store.recordFailure(id);
            assertThat(store.find(id)).isPresent();
        }
        store.recordFailure(id);
        assertThat(store.find(id)).isEmpty();
        assertThat(store.consume(id)).isEmpty();
    }

    @Test
    void aNewChallengeIsUnaffectedByAnExpiredSibling() {
        UUID first = store.store(UUID.randomUUID(), IDENTITY, TOKENS, NOW.plusSeconds(1),
                TwoFactorChallengeMode.ENROLL);
        clock.advanceSeconds(2);
        UUID second = store.store(UUID.randomUUID(), IDENTITY, TOKENS, NOW.plusSeconds(300),
                TwoFactorChallengeMode.ENROLL);

        assertThat(store.find(first)).isEmpty();
        assertThat(store.find(second)).isPresent();
    }
}
