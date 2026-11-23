package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.application.service.BotResponseTokens;
import ru.krug.backend.bot.domain.model.BotCommand;
import ru.krug.backend.bot.domain.model.BotEventType;
import ru.krug.backend.shared.error.DomainException;

class BotCommandEventDomainTest {

    @Test
    void normalizesCommandsAndRejectsDuplicatesAndBadNames() {
        BotCommand deploy = BotCommand.of(" /Deploy ", " Deploy the app ");
        assertThat(deploy.command()).isEqualTo("deploy");
        assertThat(deploy.description()).isEqualTo("Deploy the app");
        assertThat(BotCommand.normalize(List.of(deploy, BotCommand.of("status", "Status"))))
                .hasSize(2);

        assertThatThrownBy(() -> BotCommand.of("bad name", "x"))
                .isInstanceOf(DomainException.class);
        assertThat(BotCommand.of("UPPER", "x").command()).isEqualTo("upper");
        assertThatThrownBy(() -> BotCommand.of("ok", " "))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> BotCommand.normalize(List.of(deploy, deploy)))
                .isInstanceOf(DomainException.class)
                .hasMessageContaining("unique");
    }

    @Test
    void subscriptionsAreRestrictedAndDeduplicated() {
        assertThat(BotEventType.normalizeSubscriptions(List.of(" MESSAGE.CREATED ",
                "app_mention", "message.created")))
                .containsExactly("message.created", "app_mention");
        assertThatThrownBy(() -> BotEventType.normalizeSubscriptions(List.of("slash_command")))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> BotEventType.normalizeSubscriptions(List.of("test")))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void responseTokenFormatIsOneTimeAndRedacted() {
        var workspace = java.util.UUID.randomUUID();
        var tokenId = java.util.UUID.randomUUID();
        String raw = BotResponseTokens.newRawToken(workspace, tokenId);

        assertThat(raw).startsWith(BotResponseTokens.PREFIX);
        var parsed = BotResponseTokens.parse(raw).orElseThrow();
        assertThat(parsed.workspaceId()).isEqualTo(workspace);
        assertThat(parsed.tokenId()).isEqualTo(tokenId);
        assertThat(BotResponseTokens.hash(raw)).hasSize(32);
        assertThat(parsed.toString()).doesNotContain(raw.substring(raw.lastIndexOf('_') + 1));
        assertThat(BotResponseTokens.parse(raw + "x")).isEmpty();
    }
}
