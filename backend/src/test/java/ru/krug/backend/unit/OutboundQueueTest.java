package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.realtime.infrastructure.ws.OutboundFrame;
import ru.krug.backend.realtime.infrastructure.ws.OutboundQueue;

class OutboundQueueTest {

    private final UUID chatId = UUID.randomUUID();

    @Test
    void acceptsUpToCapacityThenDropsEphemeral() {
        OutboundQueue queue = new OutboundQueue(2);
        assertThat(queue.offer(durable(1))).isEqualTo(OutboundQueue.OfferResult.ACCEPTED);
        assertThat(queue.offer(durable(2))).isEqualTo(OutboundQueue.OfferResult.ACCEPTED);

        assertThat(queue.offer(ephemeral("typing"))).isEqualTo(
                OutboundQueue.OfferResult.DROPPED_EPHEMERAL);
        assertThat(queue.size()).isEqualTo(2);
    }

    @Test
    void durableOverflowEvictsAnEphemeralFrame() {
        OutboundQueue queue = new OutboundQueue(2);
        assertThat(queue.offer(ephemeral("typing"))).isEqualTo(
                OutboundQueue.OfferResult.ACCEPTED);
        assertThat(queue.offer(durable(1))).isEqualTo(OutboundQueue.OfferResult.ACCEPTED);

        assertThat(queue.offer(durable(2))).isEqualTo(OutboundQueue.OfferResult.ACCEPTED);
        assertThat(queue.poll()).isEqualTo(durable(1));
        assertThat(queue.poll()).isEqualTo(durable(2));
        assertThat(queue.size()).isZero();
    }

    @Test
    void fullQueueOfDurableFramesOverflows() {
        OutboundQueue queue = new OutboundQueue(1);
        assertThat(queue.offer(durable(1))).isEqualTo(OutboundQueue.OfferResult.ACCEPTED);

        assertThat(queue.offer(durable(2))).isEqualTo(OutboundQueue.OfferResult.OVERFLOW);
    }

    @Test
    void clearRemovesEverything() {
        OutboundQueue queue = new OutboundQueue(2);
        queue.offer(durable(1));
        queue.clear();

        assertThat(queue.size()).isZero();
        assertThat(queue.poll()).isNull();
    }

    private OutboundFrame durable(long seq) {
        return OutboundFrame.text("{\"seq\":" + seq + "}", false, chatId, seq);
    }

    private OutboundFrame ephemeral(String event) {
        return OutboundFrame.text("{\"event\":\"" + event + "\"}", true, chatId, null);
    }
}
