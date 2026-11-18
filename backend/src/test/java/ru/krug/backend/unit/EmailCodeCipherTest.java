package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.infrastructure.persistence.EmailCodeCipher;
import ru.krug.backend.support.AuthBffTestData;

class EmailCodeCipherTest {

    private final EmailCodeCipher cipher =
            new EmailCodeCipher(AuthBffTestData.properties());
    private final UUID id = UUID.randomUUID();
    private final String email = "user@krug.test";

    @Test
    void roundTripsAndNeverStoresPlaintext() {
        byte[] stored = cipher.encrypt("super-secret-totp", id, email);
        assertThat(stored.length).isGreaterThan("super-secret-totp".length());
        assertThat(new String(stored, StandardCharsets.UTF_8)).doesNotContain("super-secret-totp");
        assertThat(cipher.decrypt(stored, id, email)).isEqualTo("super-secret-totp");
    }

    @Test
    void bindsCiphertextToVerificationIdAndEmail() {
        byte[] stored = cipher.encrypt("secret", id, email);
        assertThatThrownBy(() -> cipher.decrypt(stored, UUID.randomUUID(), email))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher.decrypt(stored, id, "other@krug.test"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsTamperedCiphertext() {
        byte[] stored = cipher.encrypt("secret", id, email);
        stored[stored.length - 1] ^= 0x01;
        assertThatThrownBy(() -> cipher.decrypt(stored, id, email))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void samePlaintextUsesAFreshNonce() {
        byte[] first = cipher.encrypt("secret", id, email);
        byte[] second = cipher.encrypt("secret", id, email);
        assertThat(first).isNotEqualTo(second);
    }
}
