package ru.krug.backend.bot.application.service;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Slack-style HMAC-SHA256 webhook signature.
 *
 * <pre>
 * canonical = "v1:" + timestamp + ":" + rawBody
 * X-Sova-Signature: v1=&lt;hex(hmac_sha256(secret, canonical))&gt;
 * </pre>
 *
 * The timestamp is the epoch-second send time and must be checked by the receiver against
 * its clock. Signing is versioned so a future algorithm can coexist.
 */
public final class BotSignatures {

    public static final String VERSION = "v1";

    private BotSignatures() {
    }

    public static String sign(String secret, long timestampSeconds, byte[] body) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalArgumentException("signing secret is required");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((VERSION + ":" + timestampSeconds + ":").getBytes(StandardCharsets.UTF_8));
            byte[] digest = mac.doFinal(body == null ? new byte[0] : body);
            return VERSION + "=" + HexFormat.of().formatHex(digest);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HmacSHA256 is not available", ex);
        }
    }
}
