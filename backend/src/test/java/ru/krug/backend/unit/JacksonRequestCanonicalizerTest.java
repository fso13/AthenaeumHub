package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import ru.krug.backend.shared.infrastructure.json.JacksonRequestCanonicalizer;

class JacksonRequestCanonicalizerTest {

    private final JacksonRequestCanonicalizer canonicalizer =
            new JacksonRequestCanonicalizer(new ObjectMapper());

    @Test
    void objectKeyOrderDoesNotChangeTheHash() {
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("text", "привет");
        first.put("client_message_id", "00000000-0000-0000-0000-000000000001");
        first.put("type", "TEXT");

        Map<String, Object> second = new LinkedHashMap<>();
        second.put("type", "TEXT");
        second.put("client_message_id", "00000000-0000-0000-0000-000000000001");
        second.put("text", "привет");

        assertThat(canonicalizer.canonicalize(first)).isEqualTo(canonicalizer.canonicalize(second));
        assertThat(canonicalizer.sha256Hex(canonicalizer.canonicalize(first)))
                .isEqualTo(canonicalizer.sha256Hex(canonicalizer.canonicalize(second)));
    }

    @Test
    void differentBodiesProduceDifferentHashes() {
        assertThat(canonicalizer.sha256Hex(canonicalizer.canonicalize(Map.of("text", "a"))))
                .isNotEqualTo(canonicalizer.sha256Hex(canonicalizer.canonicalize(Map.of("text", "b"))));
    }
}
