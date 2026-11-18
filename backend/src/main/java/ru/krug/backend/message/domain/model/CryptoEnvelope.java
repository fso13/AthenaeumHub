package ru.krug.backend.message.domain.model;

import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/**
 * One opaque per-recipient-device envelope (§4.1). The server validates its shape and the
 * sender/recipient rights, stores it verbatim and never decrypts it. Arrays are copied
 * defensively so stored ciphertext can never be mutated by a caller.
 */
public record CryptoEnvelope(int v, String scheme, UUID chatId, UUID senderDeviceId,
                             int senderKeyGeneration, UUID recipientDeviceId,
                             int recipientKeyGeneration, byte[] sessionId,
                             EnvelopeHeader header, byte[] ciphertext,
                             EnvelopePrekey prekey) {

    public static final int VERSION = 1;
    public static final String SCHEME = "PAIRWISE_X3DH_DR";
    public static final int SESSION_ID_BYTES = 16;
    /**
     * Canonical v1 floor: one 256-byte padding block (256) + the 16-byte AEAD tag = 272
     * decoded bytes, i.e. 363 unpadded base64url characters. The wire contract
     * ({@code CryptoEnvelope.ciphertext.minLength}) is 363, so this is the smallest
     * envelope the server may accept and return (E2EE-REVIEW-06 P1-02).
     */
    public static final int MIN_CIPHERTEXT_BYTES = 272;
    /** Canonical v1 acceptance cap: 32768 padded inner + 256 padding block + 16 tag. */
    public static final int MAX_CIPHERTEXT_BYTES = 33040;
    public static final int MAX_GENERATION = Integer.MAX_VALUE;

    public CryptoEnvelope {
        if (v != VERSION) {
            throw new IllegalArgumentException("envelope.v must be 1");
        }
        if (!SCHEME.equals(scheme)) {
            throw new IllegalArgumentException("envelope.scheme must be " + SCHEME);
        }
        chatId = Objects.requireNonNull(chatId, "chatId");
        senderDeviceId = Objects.requireNonNull(senderDeviceId, "senderDeviceId");
        recipientDeviceId = Objects.requireNonNull(recipientDeviceId, "recipientDeviceId");
        if (senderKeyGeneration < 1 || senderKeyGeneration > MAX_GENERATION) {
            throw new IllegalArgumentException("sender_key_generation must be in 1..2^31-1");
        }
        if (recipientKeyGeneration < 1 || recipientKeyGeneration > MAX_GENERATION) {
            throw new IllegalArgumentException("recipient_key_generation must be in 1..2^31-1");
        }
        if (sessionId == null || sessionId.length != SESSION_ID_BYTES) {
            throw new IllegalArgumentException("session_id must be 16 bytes");
        }
        Objects.requireNonNull(header, "header");
        if (ciphertext == null || ciphertext.length < MIN_CIPHERTEXT_BYTES
                || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
            throw new IllegalArgumentException("ciphertext must be 272..33040 bytes");
        }
        sessionId = Arrays.copyOf(sessionId, sessionId.length);
        ciphertext = Arrays.copyOf(ciphertext, ciphertext.length);
    }

    @Override
    public byte[] sessionId() {
        return Arrays.copyOf(sessionId, sessionId.length);
    }

    @Override
    public byte[] ciphertext() {
        return Arrays.copyOf(ciphertext, ciphertext.length);
    }
}
