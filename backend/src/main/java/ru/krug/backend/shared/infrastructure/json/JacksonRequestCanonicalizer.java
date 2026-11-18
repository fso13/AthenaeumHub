package ru.krug.backend.shared.infrastructure.json;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.port.RequestCanonicalizer;

/**
 * Canonical JSON (recursively sorted keys) for Idempotency-Key hashing. Jackson lives only
 * in infrastructure; the application sees {@link RequestCanonicalizer}.
 */
@Component
public class JacksonRequestCanonicalizer implements RequestCanonicalizer {

    private final ObjectMapper mapper;

    public JacksonRequestCanonicalizer(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public String canonicalize(Object value) {
        try {
            return mapper.writeValueAsString(normalize(mapper.valueToTree(value)));
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Cannot canonicalize request body", ex);
        }
    }

    @Override
    public byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    @Override
    public String sha256Hex(String value) {
        return HexFormat.of().formatHex(sha256(value));
    }

    private static Object normalize(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isObject()) {
            Map<String, Object> sorted = new TreeMap<>();
            node.fields().forEachRemaining(entry -> sorted.put(entry.getKey(), normalize(entry.getValue())));
            return sorted;
        }
        if (node.isArray()) {
            List<Object> items = new ArrayList<>(node.size());
            node.forEach(child -> items.add(normalize(child)));
            return items;
        }
        if (node.isBoolean()) {
            return node.booleanValue();
        }
        if (node.isIntegralNumber()) {
            return node.bigIntegerValue();
        }
        if (node.isNumber()) {
            return new BigDecimal(node.decimalValue().toPlainString());
        }
        return node.textValue();
    }
}
