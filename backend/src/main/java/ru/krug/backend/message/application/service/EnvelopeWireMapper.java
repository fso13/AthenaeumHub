package ru.krug.backend.message.application.service;

import java.util.LinkedHashMap;
import java.util.Map;

import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.EnvelopeHeader;
import ru.krug.backend.message.domain.model.EnvelopePrekey;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * Rebuilds the exact wire JSON of a stored envelope for {@code Message.crypto}
 * (GET history) and for a per-device {@code message.created} frame. The map keys are the
 * contract's snake_case names; the server never adds fields.
 */
public final class EnvelopeWireMapper {

    private EnvelopeWireMapper() {
    }

    public static Map<String, Object> toWire(CryptoEnvelope envelope) {
        Map<String, Object> wire = new LinkedHashMap<>();
        wire.put("v", envelope.v());
        wire.put("scheme", envelope.scheme());
        wire.put("chat_id", envelope.chatId().toString());
        wire.put("sender_device_id", envelope.senderDeviceId().toString());
        wire.put("sender_key_generation", envelope.senderKeyGeneration());
        wire.put("recipient_device_id", envelope.recipientDeviceId().toString());
        wire.put("recipient_key_generation", envelope.recipientKeyGeneration());
        wire.put("session_id", Base64Url.encode(envelope.sessionId()));
        wire.put("header", header(envelope.header()));
        wire.put("ciphertext", Base64Url.encode(envelope.ciphertext()));
        wire.put("prekey", envelope.prekey() == null ? null : prekey(envelope.prekey()));
        return wire;
    }

    private static Map<String, Object> header(EnvelopeHeader header) {
        Map<String, Object> wire = new LinkedHashMap<>();
        wire.put("v", header.v());
        wire.put("dh", Base64Url.encode(header.dh()));
        wire.put("pn", header.pn());
        wire.put("n", header.n());
        return wire;
    }

    private static Map<String, Object> prekey(EnvelopePrekey prekey) {
        Map<String, Object> wire = new LinkedHashMap<>();
        wire.put("sender_identity_signing_key",
                Base64Url.encode(prekey.senderIdentitySigningKey()));
        wire.put("sender_identity_dh_key", Base64Url.encode(prekey.senderIdentityDhKey()));
        wire.put("sender_ephemeral_key", Base64Url.encode(prekey.senderEphemeralKey()));
        wire.put("recipient_identity_dh_key",
                Base64Url.encode(prekey.recipientIdentityDhKey()));
        wire.put("spk_id", prekey.spkId());
        wire.put("spk_public", Base64Url.encode(prekey.spkPublic()));
        wire.put("opk_id", prekey.opkId());
        wire.put("opk_public", prekey.opkPublic() == null ? null
                : Base64Url.encode(prekey.opkPublic()));
        wire.put("signature", Base64Url.encode(prekey.signature()));
        return wire;
    }
}
