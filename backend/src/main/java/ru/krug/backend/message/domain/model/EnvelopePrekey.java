package ru.krug.backend.message.domain.model;

import java.util.Arrays;

/**
 * Public prekey block of the first envelope of a session (§4.1). It contains only public
 * keys; the server stores it verbatim and never verifies a private secret. The binding of
 * the sender identity keys to the registered device is checked against
 * {@code auth.devices} before storage (E2EE-SPEC §4.7 P0-2b).
 */
public record EnvelopePrekey(byte[] senderIdentitySigningKey, byte[] senderIdentityDhKey,
                             byte[] senderEphemeralKey, byte[] recipientIdentityDhKey,
                             String spkId, byte[] spkPublic, String opkId, byte[] opkPublic,
                             byte[] signature) {

    public static final int KEY_BYTES = 32;
    public static final int SIGNATURE_BYTES = 64;

    public EnvelopePrekey {
        requireKey(senderIdentitySigningKey, "sender_identity_signing_key");
        requireKey(senderIdentityDhKey, "sender_identity_dh_key");
        requireKey(senderEphemeralKey, "sender_ephemeral_key");
        requireKey(recipientIdentityDhKey, "recipient_identity_dh_key");
        requireKey(spkPublic, "spk_public");
        if (signature == null || signature.length != SIGNATURE_BYTES) {
            throw new IllegalArgumentException("prekey.signature must be 64 bytes");
        }
        senderIdentitySigningKey = copy(senderIdentitySigningKey);
        senderIdentityDhKey = copy(senderIdentityDhKey);
        senderEphemeralKey = copy(senderEphemeralKey);
        recipientIdentityDhKey = copy(recipientIdentityDhKey);
        spkPublic = copy(spkPublic);
        signature = copy(signature);
        opkPublic = opkPublic == null ? null : copy(opkPublic);
    }

    private static void requireKey(byte[] value, String field) {
        if (value == null || value.length != KEY_BYTES) {
            throw new IllegalArgumentException("prekey." + field + " must be 32 bytes");
        }
    }

    private static byte[] copy(byte[] value) {
        return Arrays.copyOf(value, value.length);
    }

    @Override
    public byte[] senderIdentitySigningKey() {
        return copy(senderIdentitySigningKey);
    }

    @Override
    public byte[] senderIdentityDhKey() {
        return copy(senderIdentityDhKey);
    }

    @Override
    public byte[] senderEphemeralKey() {
        return copy(senderEphemeralKey);
    }

    @Override
    public byte[] recipientIdentityDhKey() {
        return copy(recipientIdentityDhKey);
    }

    @Override
    public byte[] spkPublic() {
        return copy(spkPublic);
    }

    @Override
    public byte[] opkPublic() {
        return opkPublic == null ? null : copy(opkPublic);
    }

    @Override
    public byte[] signature() {
        return copy(signature);
    }
}
