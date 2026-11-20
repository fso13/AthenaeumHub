package ru.krug.backend.auth.infrastructure.session;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.SecondFactorSessionPort;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Single-node bounded store of completed second-factor sessions, keyed by the SHA-256 of
 * the BFF refresh token. No token, code or secret is retained and nothing is logged.
 *
 * <p>The entry lifetime matches the refresh-token horizon (Keycloak default 30 days). A
 * restart loses the markers, so a 2FA-protected session re-authenticates; this is the
 * same in-memory-store limitation as the login challenge and pending-session stores.</p>
 */
@Component
public class InMemorySecondFactorSessionStore implements SecondFactorSessionPort {

    private static final Duration TTL = Duration.ofDays(30);
    private static final int MAX_ENTRIES = 100_000;

    private final ConcurrentHashMap<String, Instant> verified = new ConcurrentHashMap<>();
    private final ClockPort clock;

    public InMemorySecondFactorSessionStore(ClockPort clock) {
        this.clock = clock;
    }

    @Override
    public void markVerified(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        Instant now = clock.now();
        if (verified.size() >= MAX_ENTRIES) {
            verified.entrySet().removeIf(entry -> !now.isBefore(entry.getValue()));
        }
        verified.put(hash(refreshToken), now.plus(TTL));
    }

    @Override
    public boolean isVerified(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return false;
        }
        String digest = hash(refreshToken);
        Instant expiresAt = verified.get(digest);
        if (expiresAt == null) {
            return false;
        }
        if (!clock.now().isBefore(expiresAt)) {
            verified.remove(digest, expiresAt);
            return false;
        }
        return true;
    }

    private static String hash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                builder.append(Character.forDigit((b >> 4) & 0xf, 16));
                builder.append(Character.forDigit(b & 0xf, 16));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
