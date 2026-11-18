package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.domain.model.CryptoScheme;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;
import ru.krug.backend.message.domain.model.ThreadSummary;

class ThreadDomainTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID USER = UUID.randomUUID();
    private static final UUID DEVICE = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-18T12:00:00Z");

    @Test
    void replyCarriesThreadRootAndNeverNests() {
        UUID rootId = UUID.randomUUID();
        Message reply = Message.createText(UUID.randomUUID(), WORKSPACE, CHAT, 2, USER, DEVICE,
                "user", new MessageBody("hi"), null, rootId, UUID.randomUUID(), NOW);

        assertThat(reply.threadRootId()).isEqualTo(rootId);
        assertThat(reply.replyToId()).isNull();
        assertThat(reply.isE2ee()).isFalse();

        // A row can never be its own root (also enforced by ck_messages_thread_no_self).
        UUID sameId = UUID.randomUUID();
        assertThatThrownBy(() -> Message.createText(sameId, WORKSPACE, CHAT, 3, USER, DEVICE,
                "user", new MessageBody("self"), null, sameId, UUID.randomUUID(), NOW))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("its own thread root");
    }

    @Test
    void e2eeMessageCannotCarryThreadMetadata() {
        assertThatThrownBy(() -> Message.reconstitute(UUID.randomUUID(), WORKSPACE, CHAT, 1,
                USER, DEVICE, "user", Message.Type.TEXT, CryptoScheme.E2EE_PAIRWISE, null,
                null, null, UUID.randomUUID(), UUID.randomUUID(), NOW, null, null, 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("thread_root_id");
    }

    @Test
    void excerptCollapsesWhitespaceAndTruncatesByCodePoints() {
        assertThat(ThreadSummary.excerpt(null)).isNull();
        assertThat(ThreadSummary.excerpt("   ")).isNull();
        assertThat(ThreadSummary.excerpt(" one\n\ttwo  ")).isEqualTo("one two");

        String emoji = "😀".repeat(200);
        String excerpt = ThreadSummary.excerpt(emoji);
        assertThat(excerpt.codePointCount(0, excerpt.length()))
                .isEqualTo(ThreadSummary.MAX_EXCERPT_LENGTH);
        assertThat(excerpt).isEqualTo("😀".repeat(ThreadSummary.MAX_EXCERPT_LENGTH));

        assertThat(ThreadSummary.excerpt("short")).isEqualTo("short");
    }

    @Test
    void summaryRejectsNegativeCount() {
        assertThatThrownBy(() -> new ThreadSummary(UUID.randomUUID(), -1, NOW, USER, "x"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("replyCount");
    }
}
