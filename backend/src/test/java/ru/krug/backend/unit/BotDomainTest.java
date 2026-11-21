package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.application.service.BotTokens;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotScope;
import ru.krug.backend.bot.domain.model.BotStatus;
import ru.krug.backend.shared.error.DomainException;

class BotDomainTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID USER = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void tokenIsOneTimeFormattedAndHashed() {
        UUID botId = UUID.randomUUID();
        String token = BotTokens.newRawToken(WORKSPACE, botId);

        assertThat(token).startsWith(BotTokens.PREFIX);
        assertThat(token.length()).isBetween(90, 160);
        var parsed = BotTokens.parse(token).orElseThrow();
        assertThat(parsed.workspaceId()).isEqualTo(WORKSPACE);
        assertThat(parsed.botId()).isEqualTo(botId);
        assertThat(BotTokens.hash(token)).hasSize(32);

        // Two tokens for the same bot never collide (32 random bytes).
        assertThat(BotTokens.newRawToken(WORKSPACE, botId)).isNotEqualTo(token);
        assertThat(BotTokens.parse("not-a-token")).isEmpty();
        assertThat(BotTokens.parse(token + "x")).isEmpty();
    }

    @Test
    void tokenFormatStringDoesNotLeakSecret() {
        String token = BotTokens.newRawToken(WORKSPACE, UUID.randomUUID());
        var parsed = BotTokens.parse(token).orElseThrow();
        assertThat(parsed.toString()).doesNotContain(token.substring(token.lastIndexOf('_') + 1));
    }

    @Test
    void createNormalizesScopesAndStoresOnlyHash() {
        String token = BotTokens.newRawToken(WORKSPACE, UUID.randomUUID());
        Bot bot = Bot.create(UUID.randomUUID(), WORKSPACE, "  Deploy Bot  ", null,
                BotTokens.hash(token), List.of(" CHAT.WRITE ", "chat.write"), USER, NOW);

        assertThat(bot.name()).isEqualTo("Deploy Bot");
        assertThat(bot.scopes()).containsExactly("chat.write");
        assertThat(bot.status()).isEqualTo(BotStatus.ACTIVE);
        assertThat(bot.matchesTokenHash(BotTokens.hash(token))).isTrue();
        assertThat(bot.matchesTokenHash(BotTokens.hash(token + "x"))).isFalse();
        assertThat(bot.hasScope(BotScope.CHAT_WRITE)).isTrue();
    }

    @Test
    void rejectsEmptyNamesAndUnsupportedScopes() {
        byte[] hash = BotTokens.hash(BotTokens.newRawToken(WORKSPACE, UUID.randomUUID()));
        assertThatThrownBy(() -> Bot.create(UUID.randomUUID(), WORKSPACE, "   ", null, hash,
                List.of("chat.write"), USER, NOW))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Bot.create(UUID.randomUUID(), WORKSPACE, "bot", null, hash,
                List.of("chat.read"), USER, NOW))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Bot.create(UUID.randomUUID(), WORKSPACE, "bot", null, hash,
                List.of(), USER, NOW))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void disableEnableAndRotateAreExplicitStateChanges() {
        String token = BotTokens.newRawToken(WORKSPACE, UUID.randomUUID());
        Bot bot = Bot.create(UUID.randomUUID(), WORKSPACE, "bot", null, BotTokens.hash(token),
                List.of("chat.write"), USER, NOW);

        Bot disabled = bot.disable(NOW.plusSeconds(1));
        assertThat(disabled.status()).isEqualTo(BotStatus.DISABLED);
        assertThat(disabled.updatedAt()).isEqualTo(NOW.plusSeconds(1));
        assertThat(disabled.matchesTokenHash(BotTokens.hash(token))).isTrue();

        String second = BotTokens.newRawToken(WORKSPACE, bot.id());
        Bot rotated = disabled.rotateToken(BotTokens.hash(second), NOW.plusSeconds(2));
        assertThat(rotated.tokenRotatedAt()).isEqualTo(NOW.plusSeconds(2));
        assertThat(rotated.matchesTokenHash(BotTokens.hash(second))).isTrue();
        assertThat(rotated.matchesTokenHash(BotTokens.hash(token))).isFalse();
        assertThat(rotated.status()).isEqualTo(BotStatus.DISABLED);

        assertThat(rotated.enable(NOW.plusSeconds(3)).status()).isEqualTo(BotStatus.ACTIVE);
    }
}
