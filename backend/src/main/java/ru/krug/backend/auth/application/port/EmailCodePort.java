package ru.krug.backend.auth.application.port;

import java.time.Instant;

/**
 * RFC 6238 email-code primitives. The secret is 20 random bytes; the code is 6 decimal
 * digits with a 30-second time step. The code is never persisted.
 */
public interface EmailCodePort {

    /** A fresh 20-byte secret, base64url-encoded without padding. */
    String newSecret();

    /** The 6-digit code for the given secret at {@code at}. */
    String code(String secret, Instant at);

    /** Constant-time check with the configured ±window of 30-second steps. */
    boolean matches(String secret, String code, Instant at);
}
