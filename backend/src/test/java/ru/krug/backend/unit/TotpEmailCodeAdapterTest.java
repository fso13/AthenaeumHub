package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Base64;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.infrastructure.code.TotpEmailCodeAdapter;
import ru.krug.backend.support.AuthBffTestData;

class TotpEmailCodeAdapterTest {

    private final TotpEmailCodeAdapter adapter =
            new TotpEmailCodeAdapter(AuthBffTestData.properties());
    private final Instant now = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void generatesTwentyByteSecretsAndSixDigitCodes() {
        String first = adapter.newSecret();
        String second = adapter.newSecret();
        assertThat(Base64.getUrlDecoder().decode(first)).hasSize(20);
        assertThat(Base64.getUrlDecoder().decode(second)).hasSize(20);
        assertThat(first).isNotEqualTo(second);
        assertThat(first).doesNotContain("=", "+", "/");

        String code = adapter.code(first, now);
        assertThat(code).matches("[0-9]{6}");
        assertThat(adapter.matches(first, code, now)).isTrue();
        assertThat(adapter.matches(first, code, now.plusSeconds(30 * 5))).isTrue();
        assertThat(adapter.matches(first, code, now.plusSeconds(30 * 6))).isFalse();
    }
}
