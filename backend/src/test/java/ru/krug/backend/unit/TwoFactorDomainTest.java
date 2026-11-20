package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import ru.krug.backend.auth.domain.model.TwoFactorSettings;
import ru.krug.backend.auth.domain.service.RecoveryCodes;
import ru.krug.backend.auth.domain.service.TotpCode;
import ru.krug.backend.auth.infrastructure.persistence.TotpSecretCipher;
import ru.krug.backend.support.AuthBffTestData;

/** P0-4: TOTP step matcher, recovery-code hashing and AES-GCM secret storage. */
class TwoFactorDomainTest {

    private final UUID userId = UUID.randomUUID();
    private final TotpSecretCipher cipher = new TotpSecretCipher(AuthBffTestData.properties());

    @Test
    void matchedStepReturnsTheAcceptedStepAndRejectsMalformedCodes() {
        String secret = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "12345678901234567890".getBytes(StandardCharsets.US_ASCII));
        String code = TotpCode.generate(secret, 1234567890);
        long step = TotpCode.matchedStep(secret, code, 1234567890, 1);
        assertThat(step).isEqualTo(1234567890L / 30);
        assertThat(TotpCode.matchedStep(secret, "00000", 1234567890, 1)).isEqualTo(-1L);
        assertThat(TotpCode.matchedStep(secret, "abcdef", 1234567890, 1)).isEqualTo(-1L);
    }

    @Test
    void recoveryCodesAreTenUniqueBase32ValuesHashedPerUser() {
        List<String> codes = RecoveryCodes.newCodes();
        assertThat(codes).hasSize(10).doesNotHaveDuplicates()
                .allSatisfy(code -> assertThat(code).matches(
                        "[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}"));
        assertThat(new HashSet<>(codes)).hasSize(10);

        String hash = RecoveryCodes.hash(userId, codes.get(0));
        assertThat(hash).hasSize(64).matches("[a-f0-9]{64}");
        assertThat(RecoveryCodes.hash(userId, codes.get(0).replace("-", "").toLowerCase()))
                .isEqualTo(hash);
        assertThat(RecoveryCodes.hash(UUID.randomUUID(), codes.get(0))).isNotEqualTo(hash);
    }

    @Test
    void recoveryCodeFormatRejectsMalformedValues() {
        assertThat(RecoveryCodes.isWellFormed("ABCD-EF01-IJKL")).isFalse();
        assertThat(RecoveryCodes.isWellFormed("ABCD-EF23-4567")).isTrue();
        assertThat(RecoveryCodes.isWellFormed("ABCDEF234567")).isTrue();
        assertThatThrownBy(() -> RecoveryCodes.hash(userId, "short"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void settingsRedactTheSecretFromToStringAndTrackTheHighestUsedStep() {
        Instant now = Instant.parse("2026-06-01T00:00:00Z");
        TwoFactorSettings pending = TwoFactorSettings.pending(userId, "secret-value", now);
        assertThat(pending.isEnabled()).isFalse();
        assertThat(pending.toString()).doesNotContain("secret-value");

        TwoFactorSettings enabled = pending.enabled(now);
        assertThat(enabled.isEnabled()).isTrue();
        assertThat(enabled.withLastUsedStep(100, now).lastUsedStep()).isEqualTo(100);
        assertThat(enabled.withLastUsedStep(100, now).withLastUsedStep(50, now).lastUsedStep())
                .isEqualTo(100);
    }

    @Test
    void secretCipherRoundTripsAndBindsCiphertextToTheUser() {
        byte[] encrypted = cipher.encrypt("JBSWY3DPEHPK3PXP", userId);
        assertThat(encrypted).isNotEqualTo("JBSWY3DPEHPK3PXP".getBytes(StandardCharsets.UTF_8));
        assertThat(cipher.decrypt(encrypted, userId)).isEqualTo("JBSWY3DPEHPK3PXP");
        assertThatThrownBy(() -> cipher.decrypt(encrypted, UUID.randomUUID()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void tamperedCiphertextIsRejected() {
        byte[] encrypted = cipher.encrypt("JBSWY3DPEHPK3PXP", userId);
        encrypted[encrypted.length - 1] ^= 0x01;
        assertThatThrownBy(() -> cipher.decrypt(encrypted, userId))
                .isInstanceOf(IllegalStateException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "not-base64!"})
    void malformedSecretsAreRejected(String secret) {
        assertThatThrownBy(() -> TotpCode.generate(secret, 0))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
