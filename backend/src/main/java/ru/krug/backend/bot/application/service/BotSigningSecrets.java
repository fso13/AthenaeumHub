package ru.krug.backend.bot.application.service;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * Signing-secret format: {@code sova_whsec_<32 random bytes base64url>}. The raw value is
 * returned once by the API, encrypted at rest with {@link
 * ru.krug.backend.bot.application.port.BotSecretCipherPort} and used as the HMAC key.
 */
public final class BotSigningSecrets {

    public static final String PREFIX = "sova_whsec_";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int SECRET_BYTES = 32;

    private BotSigningSecrets() {
    }

    public static String newSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    }
}
