package ru.krug.backend.message.application.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Comparator;
import java.util.List;

import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.EnvelopeHeader;
import ru.krug.backend.message.domain.model.EnvelopePrekey;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * Deterministic fingerprint of an envelope set, used only to decide whether a repeated
 * {@code client_message_id} carries the exact same bytes (§4.2/§4.6). It is never stored,
 * never returned and never logged; it is not an authenticator.
 */
public final class EnvelopeFingerprint {

    private EnvelopeFingerprint() {
    }

    public static String of(List<CryptoEnvelope> envelopes) {
        String canonical = envelopes.stream()
                .sorted(Comparator.comparing(envelope -> envelope.recipientDeviceId().toString()))
                .map(EnvelopeFingerprint::one)
                .reduce("", (left, right) -> left + right + "\n");
        return Base64Url.encode(sha256(canonical));
    }

    private static String one(CryptoEnvelope envelope) {
        StringBuilder builder = new StringBuilder();
        builder.append(envelope.v()).append('|').append(envelope.scheme()).append('|')
                .append(envelope.chatId()).append('|').append(envelope.senderDeviceId())
                .append('|').append(envelope.senderKeyGeneration()).append('|')
                .append(envelope.recipientDeviceId()).append('|')
                .append(envelope.recipientKeyGeneration()).append('|')
                .append(Base64Url.encode(envelope.sessionId())).append('|')
                .append(header(envelope.header())).append('|')
                .append(Base64Url.encode(envelope.ciphertext())).append('|')
                .append(prekey(envelope.prekey()));
        return builder.toString();
    }

    private static String header(EnvelopeHeader header) {
        return header.v() + ":" + Base64Url.encode(header.dh()) + ":" + header.pn() + ":"
                + header.n();
    }

    private static String prekey(EnvelopePrekey prekey) {
        if (prekey == null) {
            return "-";
        }
        return Base64Url.encode(prekey.senderIdentitySigningKey()) + ":"
                + Base64Url.encode(prekey.senderIdentityDhKey()) + ":"
                + Base64Url.encode(prekey.senderEphemeralKey()) + ":"
                + Base64Url.encode(prekey.recipientIdentityDhKey()) + ":"
                + prekey.spkId() + ":" + Base64Url.encode(prekey.spkPublic()) + ":"
                + (prekey.opkId() == null ? "-" : prekey.opkId()) + ":"
                + (prekey.opkPublic() == null ? "-" : Base64Url.encode(prekey.opkPublic())) + ":"
                + Base64Url.encode(prekey.signature());
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
