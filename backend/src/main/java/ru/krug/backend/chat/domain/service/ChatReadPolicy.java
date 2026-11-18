package ru.krug.backend.chat.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Domain rule: a read receipt can never point past the chat timeline. Monotonicity is
 * additionally enforced atomically by the persistence adapter (GREATEST).
 */
public final class ChatReadPolicy {

    private ChatReadPolicy() {
    }

    public static void ensureWithinTimeline(long requestedSeq, long lastSeq) {
        if (requestedSeq < 0) {
            throw DomainException.badRequest("last_seq must be >= 0",
                    Map.of("field", "last_seq"));
        }
        if (requestedSeq > lastSeq) {
            throw DomainException.unprocessable(ErrorCode.SEQ_OUT_OF_RANGE,
                    "last_seq is ahead of the chat timeline",
                    Map.of("last_seq", requestedSeq, "max_seq", lastSeq));
        }
    }
}
