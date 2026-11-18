package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.service.ChatReadPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

class ChatDomainTest {

    @Test
    void counterAllocatesMonotonicSeqWithoutReuse() {
        ChatCounter counter = ChatCounter.newCounter(UUID.randomUUID());
        Instant now = Instant.parse("2026-11-16T09:00:00Z");

        assertThat(counter.allocate(now)).isEqualTo(1);
        assertThat(counter.allocate(now)).isEqualTo(2);
        assertThat(counter.allocate(now)).isEqualTo(3);
        assertThat(counter.lastSeq()).isEqualTo(3);
        assertThat(counter.nextSeq()).isEqualTo(4);
        assertThat(counter.lastMessageAt()).isEqualTo(now);
    }

    @Test
    void counterRejectsInvalidState() {
        assertThatThrownBy(() -> ChatCounter.reconstitute(UUID.randomUUID(), 0, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ChatCounter.newCounter(null))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void readPolicyRejectsSeqAheadOfTimeline() {
        ChatReadPolicy.ensureWithinTimeline(0, 0);
        ChatReadPolicy.ensureWithinTimeline(5, 5);

        assertThatThrownBy(() -> ChatReadPolicy.ensureWithinTimeline(6, 5))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.SEQ_OUT_OF_RANGE);
                    assertThat(ex.details()).isEqualTo(Map.of("last_seq", 6L, "max_seq", 5L));
                });
        assertThatThrownBy(() -> ChatReadPolicy.ensureWithinTimeline(-1, 5))
                .isInstanceOf(DomainException.class);
    }
}
