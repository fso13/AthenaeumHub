package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.domain.model.CryptoScheme;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;
import ru.krug.backend.message.domain.service.MessageReplyPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

class MessageDomainTest {

    private final UUID chatId = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();

    @Test
    void bodyAcceptsLimitAndRejectsLongBlankAndEmptyText() {
        assertThatCode(() -> new MessageBody("x".repeat(8000))).doesNotThrowAnyException();
        assertThat(new MessageBody("  hi  ").value()).isEqualTo("  hi  ");

        assertThatThrownBy(() -> new MessageBody(null))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("BAD_REQUEST"));
        assertThatThrownBy(() -> new MessageBody(""))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("BAD_REQUEST"));
        assertThatThrownBy(() -> new MessageBody("   "))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("UNPROCESSABLE"));
        assertThatThrownBy(() -> new MessageBody("x".repeat(8001)))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.category().name()).isEqualTo("UNPROCESSABLE");
                    assertThat(ex.code()).isEqualTo(ErrorCode.MESSAGE_TOO_LONG);
                });
    }

    @Test
    void aggregateRejectsNonPositiveSeqAndSystemBody() {
        assertThatThrownBy(() -> Message.createText(UUID.randomUUID(), workspaceId, chatId, 0,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", new MessageBody("x"), null,
                UUID.randomUUID(), Instant.now()))
                .isInstanceOf(IllegalArgumentException.class);

        // E4-B: TEXT may have no body when it carries attachments only.
        Message attachmentOnly = Message.createText(UUID.randomUUID(), workspaceId, chatId, 1,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", null, null,
                UUID.randomUUID(), Instant.now());
        assertThat(attachmentOnly.body()).isNull();

        assertThatThrownBy(() -> Message.reconstitute(UUID.randomUUID(), workspaceId, chatId, 1,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", Message.Type.SYSTEM, CryptoScheme.MANAGED,
                new MessageBody("must not be here"), null, null, UUID.randomUUID(), Instant.now(),
                null, null, 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void stickerMessageRequiresStickerAndNoBody() {
        UUID messageId = UUID.randomUUID();
        UUID stickerId = UUID.randomUUID();
        Message sticker = Message.createSticker(messageId, workspaceId, chatId, 2,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", stickerId, null,
                UUID.randomUUID(), Instant.now());

        assertThat(sticker.type()).isEqualTo(Message.Type.STICKER);
        assertThat(sticker.stickerId()).isEqualTo(stickerId);
        assertThat(sticker.body()).isNull();

        assertThatThrownBy(() -> Message.createSticker(messageId, workspaceId, chatId, 2,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", null, null,
                UUID.randomUUID(), Instant.now()))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> Message.reconstitute(messageId, workspaceId, chatId, 2,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", Message.Type.STICKER, CryptoScheme.MANAGED,
                new MessageBody("not allowed"), stickerId, null, UUID.randomUUID(), Instant.now(),
                null, null, 1))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> Message.reconstitute(messageId, workspaceId, chatId, 2,
                UUID.randomUUID(), UUID.randomUUID(), "Дмитрий", Message.Type.TEXT, CryptoScheme.MANAGED,
                new MessageBody("text"), stickerId, null, UUID.randomUUID(), Instant.now(),
                null, null, 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aggregateBuildsValidTextMessage() {
        UUID messageId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();
        Message message = Message.createText(messageId, workspaceId, chatId, 7, UUID.randomUUID(),
                UUID.randomUUID(), "Дмитрий", new MessageBody("привет"), null, clientId,
                Instant.parse("2026-11-16T09:00:00Z"));

        assertThat(message.seq()).isEqualTo(7);
        assertThat(message.body().value()).isEqualTo("привет");
        assertThat(message.clientMessageId()).isEqualTo(clientId);
        assertThat(message.version()).isEqualTo(1);
    }

    @Test
    void replyMustBelongToTheSameChat() {
        UUID replyTo = UUID.randomUUID();
        assertThatCode(() -> MessageReplyPolicy.ensureReplyTarget(chatId, replyTo,
                Optional.of(chatId))).doesNotThrowAnyException();
        assertThatCode(() -> MessageReplyPolicy.ensureReplyTarget(chatId, null,
                Optional.empty())).doesNotThrowAnyException();

        assertThatThrownBy(() -> MessageReplyPolicy.ensureReplyTarget(chatId, replyTo,
                Optional.empty()))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.category().name()).isEqualTo("UNPROCESSABLE");
                    assertThat(ex.details()).containsEntry("field", "reply_to_id");
                });
        assertThatThrownBy(() -> MessageReplyPolicy.ensureReplyTarget(chatId, replyTo,
                Optional.of(UUID.randomUUID())))
                .isInstanceOf(DomainException.class);
    }
}
