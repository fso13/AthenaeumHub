package ru.krug.backend.message.domain.model;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Value object with the text invariants from FR-CHAT-4: 1..8000 characters, not blank.
 */
public record MessageBody(String value) {

    public static final int MAX_LENGTH = 8000;

    public MessageBody {
        if (value == null || value.isEmpty()) {
            throw DomainException.badRequest("text must not be empty", Map.of("field", "text"));
        }
        if (value.isBlank()) {
            throw DomainException.unprocessable("text must contain visible characters",
                    Map.of("field", "text", "reason", "blank"));
        }
        if (value.length() > MAX_LENGTH) {
            throw DomainException.unprocessable(ErrorCode.MESSAGE_TOO_LONG,
                    "Message text exceeds 8000 characters",
                    Map.of("max_length", MAX_LENGTH, "actual_length", value.length()));
        }
    }
}
