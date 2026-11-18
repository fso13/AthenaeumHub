package ru.krug.backend.shared.api;

import java.io.IOException;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;

/**
 * E2EE-REVIEW-07 P2-06: explicit canonicalization of request-level UUIDs.
 *
 * <p>Jackson's default {@link UUID} deserializer accepts upper-case hex and silently
 * returns a lower-case {@link UUID}. That is safe for equality, but it left the wire
 * contract, audit logs and the request-level idempotency identity with an implicit
 * parser differential. This deserializer makes the rule explicit and deterministic:
 *
 * <ul>
 *   <li>the canonical 8-4-4-4-12 hyphenated form is accepted in either hex case;</li>
 *   <li>the value is normalized to lower-case before it reaches the domain, so the
 *       canonical {@link UUID#toString()} form is the only one an application ever
 *       sees (and therefore the only one used for hashing/echo);</li>
 *   <li>lenient forms such as {@code 1-1-1-1-1}, braces or URNs are rejected with the
 *       normal {@code 400 VALIDATION_FAILED} envelope.</li>
 * </ul>
 *
 * <p>This intentionally does <em>not</em> reject upper-case hex: that would break
 * existing clients without a security benefit, because the parsed {@link UUID} is
 * already canonical. Envelope UUIDs remain strict/canonical at the wire layer
 * ({@code EnvelopeCodec}, E2EE-SPEC §4.7).
 */
public final class CanonicalUuidDeserializer extends JsonDeserializer<UUID> {

    private static final Pattern CANONICAL = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    @Override
    public UUID deserialize(JsonParser parser, DeserializationContext context)
            throws IOException {
        if (parser.currentToken() != JsonToken.VALUE_STRING) {
            return (UUID) context.handleUnexpectedToken(UUID.class, parser);
        }
        String value = parser.getText();
        if (!CANONICAL.matcher(value).matches()) {
            return (UUID) context.handleWeirdStringValue(UUID.class, value,
                    "must be a canonical 8-4-4-4-12 UUID");
        }
        return UUID.fromString(value.toLowerCase(Locale.ROOT));
    }
}
