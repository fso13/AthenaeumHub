package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.infrastructure.persistence.BotSecretCipher;
import ru.krug.backend.support.TestProperties;

class BotSecretCipherTest {

    @Test
    void encryptsSecretAndPayloadWithAadBinding() {
        BotSecretCipher cipher = new BotSecretCipher(TestProperties.defaults());
        UUID botId = UUID.randomUUID();
        UUID deliveryId = UUID.randomUUID();
        String secret = "sova_whsec_one_time_secret_value";
        String payload = "{\"type\":\"message.created\",\"message\":{\"text\":\"hi\"}}";

        byte[] encryptedSecret = cipher.encryptSecret(secret, botId);
        byte[] encryptedPayload = cipher.encryptPayload(payload, deliveryId);

        assertThat(new String(encryptedSecret, StandardCharsets.ISO_8859_1))
                .doesNotContain(secret);
        assertThat(new String(encryptedPayload, StandardCharsets.ISO_8859_1))
                .doesNotContain("message.created");
        assertThat(cipher.decryptSecret(encryptedSecret, botId)).isEqualTo(secret);
        assertThat(cipher.decryptPayload(encryptedPayload, deliveryId)).isEqualTo(payload);

        assertThatThrownBy(() -> cipher.decryptSecret(encryptedSecret, UUID.randomUUID()))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher.decryptPayload(encryptedPayload, UUID.randomUUID()))
                .isInstanceOf(IllegalStateException.class);
    }
}
