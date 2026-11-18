package ru.krug.backend.message.application.model;

import java.util.List;

import ru.krug.backend.message.domain.model.CryptoEnvelope;

/**
 * Parsed {@code envelopes[]} of one request. {@code present} keeps "field absent" and
 * "field present but empty" apart: E2EE requires at least one envelope, managed chats must
 * not receive the field at all.
 */
public record EnvelopeBatch(boolean present, List<CryptoEnvelope> envelopes) {

    public static final EnvelopeBatch ABSENT = new EnvelopeBatch(false, List.of());

    public EnvelopeBatch {
        envelopes = envelopes == null ? List.of() : List.copyOf(envelopes);
    }

    public boolean isEmpty() {
        return envelopes.isEmpty();
    }
}
