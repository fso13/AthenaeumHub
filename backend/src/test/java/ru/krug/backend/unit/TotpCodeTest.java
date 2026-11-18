package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.domain.service.TotpCode;

/** RFC 6238 SHA-1 test vectors and the ±5-step window (docs/TASKS-AUTH-BFF.md §2). */
class TotpCodeTest {

    private static final String RFC_SECRET = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("12345678901234567890".getBytes(StandardCharsets.US_ASCII));

    @Test
    void matchesRfc6238SixDigitVectors() {
        assertThat(TotpCode.generate(RFC_SECRET, 59)).isEqualTo("287082");
        assertThat(TotpCode.generate(RFC_SECRET, 1111111109)).isEqualTo("081804");
        assertThat(TotpCode.generate(RFC_SECRET, 1111111111)).isEqualTo("050471");
        assertThat(TotpCode.generate(RFC_SECRET, 1234567890)).isEqualTo("005924");
        assertThat(TotpCode.generate(RFC_SECRET, 2000000000)).isEqualTo("279037");
        assertThat(TotpCode.generate(RFC_SECRET, 20000000000L)).isEqualTo("353130");
    }

    @Test
    void acceptsAdjacentStepsWithinTheFiveMinuteWindow() {
        String code = TotpCode.generate(RFC_SECRET, 1234567890);
        assertThat(TotpCode.matches(RFC_SECRET, code, 1234567890, 5)).isTrue();
        assertThat(TotpCode.matches(RFC_SECRET, code, 1234567890 + 5 * 30, 5)).isTrue();
        assertThat(TotpCode.matches(RFC_SECRET, code, 1234567890 - 5 * 30, 5)).isTrue();
        assertThat(TotpCode.matches(RFC_SECRET, code, 1234567890 + 6 * 30, 5)).isFalse();
        assertThat(TotpCode.matches(RFC_SECRET, code, 1234567890 - 6 * 30, 5)).isFalse();
    }

    @Test
    void rejectsMalformedCodesWithoutThrowing() {
        assertThat(TotpCode.matches(RFC_SECRET, null, 1234567890, 5)).isFalse();
        assertThat(TotpCode.matches(RFC_SECRET, "12345", 1234567890, 5)).isFalse();
        assertThat(TotpCode.matches(RFC_SECRET, "abcdef", 1234567890, 5)).isFalse();
        assertThat(TotpCode.matches(RFC_SECRET, "1234567", 1234567890, 5)).isFalse();
        assertThat(TotpCode.isWellFormed("000000")).isTrue();
        assertThat(TotpCode.isWellFormed(" 000000")).isFalse();
    }

    @Test
    void secretIsTwentyBytesBase64Url() {
        byte[] decoded = Base64.getUrlDecoder().decode(RFC_SECRET);
        assertThat(decoded).hasSize(20);
        assertThat(RFC_SECRET).doesNotContain("=", "+", "/");
    }

    @Test
    void blankOrNonBase64SecretIsRejected() {
        assertThatThrownBy(() -> TotpCode.generate("", 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TotpCode.generate("not base64!", 0))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
