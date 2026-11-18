package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.infrastructure.persistence.MessageCipher;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;
import ru.krug.backend.support.TestProperties;

class MessageCipherTest {

    private final MessageCipher cipher = new MessageCipher(TestProperties.defaults());
    private final String aad = MessageCipher.aad(UUID.randomUUID(), UUID.randomUUID(),
            UUID.randomUUID());

    @Test
    void encryptsAndDecryptsWithoutStoringPlaintext() {
        String plaintext = "секретный текст";
        byte[] encrypted = cipher.encrypt(plaintext, aad);

        assertThat(encrypted).isNotNull();
        assertThat(new String(encrypted, StandardCharsets.UTF_8)).doesNotContain(plaintext);
        assertThat(cipher.decrypt(encrypted, aad)).isEqualTo(plaintext);
    }

    @Test
    void usesRandomNonceSoCiphertextsDiffer() {
        assertThat(Arrays.equals(cipher.encrypt("same", aad), cipher.encrypt("same", aad)))
                .isFalse();
    }

    @Test
    void failsOnTamperedCiphertextOrWrongAad() {
        byte[] encrypted = cipher.encrypt("secret", aad);
        byte[] tampered = encrypted.clone();
        tampered[tampered.length - 1] ^= 0x01;
        assertThatThrownBy(() -> cipher.decrypt(tampered, aad))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher.decrypt(encrypted, aad + ":other"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsShortKeyMaterial() {
        KrugProperties base = TestProperties.defaults();
        KrugProperties weak = new KrugProperties(base.auth(),
                new KrugProperties.Content("too-short"), base.dev(), base.rateLimit(),
                base.outbox(), base.oidc(), base.e2ee());
        assertThatThrownBy(() -> new MessageCipher(weak)).isInstanceOf(IllegalStateException.class);
    }
}
