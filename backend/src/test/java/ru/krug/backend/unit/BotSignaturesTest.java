package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.application.service.BotSignatures;

class BotSignaturesTest {

    @Test
    void signsVersionedTimestampAndRawBody() throws Exception {
        String secret = "sova_whsec_test_secret_32_bytes_long_value";
        byte[] body = "{\"type\":\"message.created\"}".getBytes(StandardCharsets.UTF_8);
        long timestamp = 1_760_000_000L;

        String expected = "v1=" + HexFormat.of().formatHex(hmac(secret,
                "v1:" + timestamp + ":" + new String(body, StandardCharsets.UTF_8)));

        assertThat(BotSignatures.sign(secret, timestamp, body)).isEqualTo(expected);
        assertThat(BotSignatures.sign(secret, timestamp + 1, body)).isNotEqualTo(expected);
        assertThat(BotSignatures.sign(secret + "x", timestamp, body)).isNotEqualTo(expected);
        assertThat(BotSignatures.sign(secret, timestamp,
                "{\"type\":\"app_mention\"}".getBytes(StandardCharsets.UTF_8)))
                .isNotEqualTo(expected);
    }

    private static byte[] hmac(String secret, String canonical) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8));
    }
}
