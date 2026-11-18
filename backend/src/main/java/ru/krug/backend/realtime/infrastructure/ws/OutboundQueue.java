package ru.krug.backend.realtime.infrastructure.ws;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * Bounded per-connection outbound queue (256 frames by default). On overflow, ephemeral
 * frames (typing/presence) are dropped first; if only durable frames remain, the connection
 * is declared a slow consumer and the caller closes it with 1013.
 */
public final class OutboundQueue {

    public enum OfferResult {
        ACCEPTED,
        DROPPED_EPHEMERAL,
        OVERFLOW
    }

    private final int capacity;
    private final ArrayDeque<OutboundFrame> frames;

    public OutboundQueue(int capacity) {
        if (capacity < 1) {
            throw new IllegalArgumentException("queue capacity must be positive");
        }
        this.capacity = capacity;
        this.frames = new ArrayDeque<>(capacity);
    }

    public synchronized OfferResult offer(OutboundFrame frame) {
        if (frames.size() < capacity) {
            frames.addLast(frame);
            return OfferResult.ACCEPTED;
        }
        if (frame.ephemeral()) {
            return OfferResult.DROPPED_EPHEMERAL;
        }
        Iterator<OutboundFrame> iterator = frames.iterator();
        while (iterator.hasNext()) {
            if (iterator.next().ephemeral()) {
                iterator.remove();
                frames.addLast(frame);
                return OfferResult.ACCEPTED;
            }
        }
        return OfferResult.OVERFLOW;
    }

    public synchronized OutboundFrame poll() {
        return frames.pollFirst();
    }

    public synchronized int size() {
        return frames.size();
    }

    public synchronized void clear() {
        frames.clear();
    }
}
