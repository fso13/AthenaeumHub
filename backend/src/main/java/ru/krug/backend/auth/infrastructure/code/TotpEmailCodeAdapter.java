package ru.krug.backend.auth.infrastructure.code;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.EmailCodePort;
import ru.krug.backend.auth.domain.service.TotpCode;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;

/**
 * RFC 6238 adapter: 20 random bytes, base64url secret, SHA-1 6-digit codes with the
 * configured adjacent-step window.
 */
@Component
public class TotpEmailCodeAdapter implements EmailCodePort {

    private static final int SECRET_BYTES = 20;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final int window;

    public TotpEmailCodeAdapter(AuthBffProperties properties) {
        this.window = Math.max(0, properties.code().window());
    }

    @Override
    public String newSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    }

    @Override
    public String code(String secret, Instant at) {
        return TotpCode.generate(secret, at.getEpochSecond());
    }

    @Override
    public boolean matches(String secret, String code, Instant at) {
        return TotpCode.matches(secret, code, at.getEpochSecond(), window);
    }
}
