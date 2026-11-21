package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;

class BotMessageDomainTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID BOT = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void botMessageHasBotSenderAndNoUserIdentity() {
        Message message = Message.createBotText(UUID.randomUUID(), WORKSPACE, CHAT, 1, BOT,
                "Deploy Bot", new MessageBody("build finished"), NOW);

        assertThat(message.senderType()).isEqualTo(Message.SenderType.BOT);
        assertThat(message.isBotMessage()).isTrue();
        assertThat(message.botId()).isEqualTo(BOT);
        assertThat(message.senderId()).isNull();
        assertThat(message.senderDeviceId()).isNull();
        assertThat(message.senderDisplayName()).isEqualTo("Deploy Bot");
        assertThat(message.type()).isEqualTo(Message.Type.TEXT);
        assertThat(message.cryptoScheme()).isEqualTo(ru.krug.backend.message.domain.model.CryptoScheme.MANAGED);
        assertThat(message.body().value()).isEqualTo("build finished");
    }

    @Test
    void userMessageHasNoBotId() {
        Message message = Message.createText(UUID.randomUUID(), WORKSPACE, CHAT, 1,
                UUID.randomUUID(), UUID.randomUUID(), "User", new MessageBody("hello"), null,
                null, NOW);
        assertThat(message.senderType()).isEqualTo(Message.SenderType.USER);
        assertThat(message.isBotMessage()).isFalse();
        assertThat(message.botId()).isNull();
    }

    @Test
    void botMessageRejectsE2eeAndMissingBotId() {
        assertThatThrownBy(() -> Message.createBotText(UUID.randomUUID(), WORKSPACE, CHAT, 1,
                null, "Bot", new MessageBody("x"), NOW))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bot id");
        assertThatThrownBy(() -> Message.reconstitute(UUID.randomUUID(), WORKSPACE, CHAT, 1,
                null, null, "Bot", Message.Type.TEXT,
                ru.krug.backend.message.domain.model.CryptoScheme.E2EE_PAIRWISE, null, null,
                null, null, null, null, null, java.util.List.of(), false, NOW, null, null, 1,
                Message.SenderType.BOT, BOT))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
