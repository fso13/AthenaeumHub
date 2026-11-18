package ru.krug.backend.message.application.service;

import java.util.regex.Pattern;

import ru.krug.backend.message.domain.model.CryptoEnvelope;

/**
 * E2EE wire limits (E2EE-SPEC §4.5). Values are part of the wire contract, not tuning:
 * decoded ciphertext 272..33040 B (encoded 363..44054), form guard 65536 before decode,
 * at most 10 envelopes per message, 16-byte session id.
 */
public final class EnvelopeLimits {

    public static final int MAX_ENVELOPES = 10;
    public static final int SESSION_ID_BYTES = CryptoEnvelope.SESSION_ID_BYTES;
    public static final int MIN_CIPHERTEXT_BYTES = CryptoEnvelope.MIN_CIPHERTEXT_BYTES;
    public static final int MAX_CIPHERTEXT_BYTES = CryptoEnvelope.MAX_CIPHERTEXT_BYTES;
    /** Canonical floor on the encoded string (272 bytes = 363 characters). */
    public static final int MIN_CIPHERTEXT_ENCODED = 363;
    /** Canonical acceptance cap on the encoded string (44 054 characters). */
    public static final int MAX_CIPHERTEXT_ENCODED = 44054;
    /** Form guard applied before base64 decoding (P2-11). */
    public static final int FORM_GUARD_ENCODED = 65536;
    public static final int MAX_KEY_ID_LENGTH = 64;
    public static final Pattern KEY_ID = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");

    private EnvelopeLimits() {
    }
}
