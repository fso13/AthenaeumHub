package ru.krug.backend.message.application.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;

import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.EnvelopeHeader;
import ru.krug.backend.message.domain.model.EnvelopePrekey;
import ru.krug.backend.shared.application.model.Base64Url;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Strict parser for {@code envelopes[]} (E2EE-SPEC §4.7). It validates only the public
 * shape: canonical unpadded base64url, exact byte lengths, numeric ranges and
 * {@code additionalProperties:false}. It never decodes the content and never touches keys.
 * Device/membership/generation checks live in {@link E2eeEnvelopeValidator}.
 */
public final class EnvelopeCodec {

    private static final Set<String> ENVELOPE_FIELDS = Set.of("v", "scheme", "chat_id",
            "sender_device_id", "sender_key_generation", "recipient_device_id",
            "recipient_key_generation", "session_id", "header", "ciphertext", "prekey");
    private static final Set<String> HEADER_FIELDS = Set.of("v", "dh", "pn", "n");
    private static final Set<String> PREKEY_FIELDS = Set.of("sender_identity_signing_key",
            "sender_identity_dh_key", "sender_ephemeral_key", "recipient_identity_dh_key",
            "spk_id", "spk_public", "opk_id", "opk_public", "signature");

    private EnvelopeCodec() {
    }

    public static List<CryptoEnvelope> parse(JsonNode array) {
        if (array == null || !array.isArray()) {
            throw invalid("envelopes", "array_required");
        }
        if (array.size() > EnvelopeLimits.MAX_ENVELOPES) {
            throw DomainException.unprocessable(ErrorCode.TOO_MANY_ENVELOPES,
                    "A message can carry at most 10 envelopes",
                    Map.of("limit", EnvelopeLimits.MAX_ENVELOPES, "actual", array.size()));
        }
        List<CryptoEnvelope> parsed = new ArrayList<>(array.size());
        for (int i = 0; i < array.size(); i++) {
            parsed.add(parseOne(array.get(i), i));
        }
        return List.copyOf(parsed);
    }

    private static CryptoEnvelope parseOne(JsonNode node, int index) {
        String path = "envelopes[" + index + "]";
        if (node == null || !node.isObject()) {
            throw invalid(path, "object_required");
        }
        requireOnlyFields(node, ENVELOPE_FIELDS, path);
        int version = requireInt(node, "v", path, Integer.MIN_VALUE, Integer.MAX_VALUE);
        if (version != CryptoEnvelope.VERSION) {
            throw DomainException.unprocessable(ErrorCode.UNSUPPORTED_ENVELOPE_VERSION,
                    "Unsupported envelope version",
                    Map.of("field", path + ".v", "supported", CryptoEnvelope.VERSION));
        }
        String scheme = requireText(node, "scheme", path);
        if (!CryptoEnvelope.SCHEME.equals(scheme)) {
            throw invalid(path + ".scheme", "unsupported_scheme");
        }
        UUID chatId = requireUuid(node, "chat_id", path);
        UUID senderDeviceId = requireUuid(node, "sender_device_id", path);
        int senderGeneration = requireInt(node, "sender_key_generation", path, 1,
                CryptoEnvelope.MAX_GENERATION);
        UUID recipientDeviceId = requireUuid(node, "recipient_device_id", path);
        int recipientGeneration = requireInt(node, "recipient_key_generation", path, 1,
                CryptoEnvelope.MAX_GENERATION);
        byte[] sessionId = requireBase64(node, "session_id", path,
                EnvelopeLimits.SESSION_ID_BYTES);
        EnvelopeHeader header = parseHeader(node.get("header"), path + ".header");
        byte[] ciphertext = parseCiphertext(node.get("ciphertext"), path + ".ciphertext");
        EnvelopePrekey prekey = node.hasNonNull("prekey")
                ? parsePrekey(node.get("prekey"), path + ".prekey") : null;
        try {
            return new CryptoEnvelope(version, scheme, chatId, senderDeviceId, senderGeneration,
                    recipientDeviceId, recipientGeneration, sessionId, header, ciphertext, prekey);
        } catch (IllegalArgumentException ex) {
            throw invalid(path, "invalid_value");
        }
    }

    private static EnvelopeHeader parseHeader(JsonNode node, String path) {
        if (node == null || !node.isObject()) {
            throw invalid(path, "object_required");
        }
        requireOnlyFields(node, HEADER_FIELDS, path);
        int version = requireInt(node, "v", path, Integer.MIN_VALUE, Integer.MAX_VALUE);
        if (version != EnvelopeHeader.VERSION) {
            throw invalid(path + ".v", "unsupported_version");
        }
        byte[] dh = requireBase64(node, "dh", path, EnvelopeHeader.DH_BYTES);
        long pn = requireLong(node, "pn", path, 0, EnvelopeHeader.MAX_COUNTER);
        long n = requireLong(node, "n", path, 0, EnvelopeHeader.MAX_COUNTER);
        return new EnvelopeHeader(version, dh, pn, n);
    }

    private static byte[] parseCiphertext(JsonNode node, String path) {
        String encoded = requireTextAt(node, path);
        if (encoded.length() > EnvelopeLimits.FORM_GUARD_ENCODED) {
            throw tooLarge(path, "form");
        }
        if (encoded.length() < EnvelopeLimits.MIN_CIPHERTEXT_ENCODED) {
            throw invalid(path, "ciphertext_too_short");
        }
        byte[] decoded = Base64Url.decode(encoded).orElseThrow(
                () -> invalid(path, "base64url"));
        if (decoded.length < EnvelopeLimits.MIN_CIPHERTEXT_BYTES) {
            throw invalid(path, "ciphertext_too_short");
        }
        if (decoded.length > EnvelopeLimits.MAX_CIPHERTEXT_BYTES
                || encoded.length() > EnvelopeLimits.MAX_CIPHERTEXT_ENCODED) {
            throw tooLarge(path, "canonical");
        }
        return decoded;
    }

    private static EnvelopePrekey parsePrekey(JsonNode node, String path) {
        if (!node.isObject()) {
            throw invalid(path, "object_required");
        }
        requireOnlyFields(node, PREKEY_FIELDS, path);
        byte[] senderSigning = requireBase64(node, "sender_identity_signing_key", path, 32);
        byte[] senderDh = requireBase64(node, "sender_identity_dh_key", path, 32);
        byte[] ephemeral = requireBase64(node, "sender_ephemeral_key", path, 32);
        byte[] recipientDh = requireBase64(node, "recipient_identity_dh_key", path, 32);
        String spkId = requireKeyId(node, "spk_id", path, false);
        byte[] spkPublic = requireBase64(node, "spk_public", path, 32);
        String opkId = node.hasNonNull("opk_id") ? requireKeyId(node, "opk_id", path, true)
                : null;
        byte[] opkPublic = node.hasNonNull("opk_public")
                ? requireBase64(node, "opk_public", path, 32) : null;
        if ((opkId == null) != (opkPublic == null)) {
            throw invalid(path + ".opk_id", "opk_pair_required");
        }
        byte[] signature = requireBase64(node, "signature", path, 64);
        try {
            return new EnvelopePrekey(senderSigning, senderDh, ephemeral, recipientDh, spkId,
                    spkPublic, opkId, opkPublic, signature);
        } catch (IllegalArgumentException ex) {
            throw invalid(path, "invalid_value");
        }
    }

    private static void requireOnlyFields(JsonNode node, Set<String> allowed, String path) {
        var names = node.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            if (!allowed.contains(name)) {
                throw invalid(path + "." + name, "unknown_field");
            }
        }
    }

    private static String requireText(JsonNode node, String field, String path) {
        return requireTextAt(node.get(field), path + "." + field);
    }

    private static String requireTextAt(JsonNode node, String path) {
        if (node == null || !node.isTextual()) {
            throw invalid(path, "string_required");
        }
        return node.asText();
    }

    private static UUID requireUuid(JsonNode node, String field, String path) {
        String value = requireText(node, field, path);
        try {
            UUID uuid = UUID.fromString(value);
            // P2-04: only canonical lower-case 8-4-4-4-12 is accepted. UUID.fromString is
            // lenient ("1-1-1-1-1", upper-case, leading zeros), which creates a parser
            // differential with any second parser (audit/proxy/future client validator).
            if (!uuid.toString().equals(value)) {
                throw invalid(path + "." + field, "uuid_not_canonical");
            }
            return uuid;
        } catch (IllegalArgumentException ex) {
            throw invalid(path + "." + field, "uuid_required");
        }
    }

    private static int requireInt(JsonNode node, String field, String path, int min, int max) {
        return (int) requireLong(node, field, path, min, max);
    }

    private static long requireLong(JsonNode node, String field, String path, long min,
                                    long max) {
        JsonNode value = node.get(field);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong()) {
            throw invalid(path + "." + field, "integer_required");
        }
        long number = value.asLong();
        if (number < min || number > max) {
            throw invalid(path + "." + field, "out_of_range");
        }
        return number;
    }

    private static byte[] requireBase64(JsonNode node, String field, String path,
                                        int expectedBytes) {
        String value = requireText(node, field, path);
        return Base64Url.decode(value, expectedBytes).orElseThrow(
                () -> invalid(path + "." + field, "base64url"));
    }

    private static String requireKeyId(JsonNode node, String field, String path,
                                       boolean nullable) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            if (nullable) {
                return null;
            }
            throw invalid(path + "." + field, "string_required");
        }
        if (!value.isTextual() || !EnvelopeLimits.KEY_ID.matcher(value.asText()).matches()) {
            throw invalid(path + "." + field, "key_id");
        }
        return value.asText();
    }

    private static DomainException invalid(String field, String reason) {
        return DomainException.unprocessable(ErrorCode.INVALID_ENVELOPE_FORMAT,
                "Invalid envelope format", Map.of("field", field, "reason", reason));
    }

    private static DomainException tooLarge(String field, String reason) {
        return DomainException.payloadTooLarge(ErrorCode.ENVELOPE_TOO_LARGE,
                "Envelope ciphertext exceeds the acceptance limit",
                Map.of("field", field, "reason", reason));
    }
}
