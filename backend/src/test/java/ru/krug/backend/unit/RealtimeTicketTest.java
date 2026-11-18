package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;

import org.junit.jupiter.api.Test;

import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketId;
import ru.krug.backend.realtime.domain.model.TicketToken;

class RealtimeTicketTest {

    private static final Instant NOW = Instant.parse("2026-11-16T10:00:00Z");

    @Test
    void issuesWithThirtySecondTtl() {
        RealtimeTicket ticket = RealtimeTicket.issue(TicketId.newId(),
                TicketToken.generate().hash(), java.util.UUID.randomUUID(),
                java.util.UUID.randomUUID(), java.util.UUID.randomUUID(), NOW,
                Duration.ofSeconds(30));

        assertThat(ticket.expiresAt()).isEqualTo(NOW.plusSeconds(30));
        assertThat(ticket.isUsable(NOW)).isTrue();
        assertThat(ticket.isConsumed()).isFalse();
    }

    @Test
    void expiryIsExclusiveAtTheBoundary() {
        RealtimeTicket ticket = RealtimeTicket.issue(TicketId.newId(),
                TicketToken.generate().hash(), java.util.UUID.randomUUID(),
                java.util.UUID.randomUUID(), null, NOW, Duration.ofSeconds(30));

        assertThat(ticket.isExpired(NOW.plusSeconds(29))).isFalse();
        assertThat(ticket.isExpired(NOW.plusSeconds(30))).isTrue();
        assertThat(ticket.isUsable(NOW.plusSeconds(30))).isFalse();
    }

    @Test
    void rejectsNonPositiveAndExcessiveTtl() {
        assertThatThrownBy(() -> RealtimeTicket.issue(TicketId.newId(),
                TicketToken.generate().hash(), java.util.UUID.randomUUID(),
                java.util.UUID.randomUUID(), null, NOW, Duration.ZERO))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> RealtimeTicket.issue(TicketId.newId(),
                TicketToken.generate().hash(), java.util.UUID.randomUUID(),
                java.util.UUID.randomUUID(), null, NOW, Duration.ofMinutes(6)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void tokenIsOpaqueAndOnlyTheHashIsDerived() {
        TicketToken token = TicketToken.generate();

        assertThat(token.value()).hasSize(43).matches("[A-Za-z0-9_-]+");
        assertThat(token.hash().value()).hasSize(64).matches("[0-9a-f]{64}");
        assertThat(token.hash().value()).isNotEqualTo(token.value());
        assertThat(TicketToken.of(token.value()).hash()).isEqualTo(token.hash());
    }

    @Test
    void rejectsMalformedToken() {
        assertThatThrownBy(() -> TicketToken.of("short"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TicketToken.of(null))
                .isInstanceOf(NullPointerException.class);
    }
}
