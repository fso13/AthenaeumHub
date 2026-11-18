package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.infrastructure.persistence.SmtpPasswordCipher;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

class SmtpPasswordCipherTest {

    private static final String KEY = "unit-test-content-key-please-change-32-bytes";

    private static SmtpPasswordCipher cipher(String key) {
        return new SmtpPasswordCipher(new KrugProperties(null,
                new KrugProperties.Content(key), null, null, null, null, null));
    }

    @Test
    void roundTripsAndNeverStoresPlaintext() {
        SmtpPasswordCipher cipher = cipher(KEY);
        String secret = "smtp-password-42!";

        byte[] ciphertext = cipher.encrypt(secret);

        assertThat(ciphertext).isNotEqualTo(secret.getBytes(StandardCharsets.UTF_8));
        assertThat(new String(ciphertext, StandardCharsets.UTF_8)).doesNotContain(secret);
        assertThat(cipher.decrypt(ciphertext)).isEqualTo(secret);
    }

    @Test
    void usesAFreshNoncePerEncryption() {
        SmtpPasswordCipher cipher = cipher(KEY);
        byte[] first = cipher.encrypt("same-secret");
        byte[] second = cipher.encrypt("same-secret");
        assertThat(first).isNotEqualTo(second);
        assertThat(cipher.decrypt(first)).isEqualTo("same-secret");
        assertThat(cipher.decrypt(second)).isEqualTo("same-secret");
    }

    @Test
    void rejectsTamperedCiphertextAndUnsupportedVersion() {
        SmtpPasswordCipher cipher = cipher(KEY);
        byte[] ciphertext = cipher.encrypt("secret");
        byte[] tampered = ciphertext.clone();
        tampered[tampered.length - 1] ^= 0x01;
        assertThatThrownBy(() -> cipher.decrypt(tampered))
                .isInstanceOf(IllegalStateException.class);

        byte[] wrongVersion = ciphertext.clone();
        wrongVersion[0] = 9;
        assertThatThrownBy(() -> cipher.decrypt(wrongVersion))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsShortContentKey() {
        assertThatThrownBy(() -> cipher("too-short"))
                .isInstanceOf(IllegalStateException.class);
    }
}
