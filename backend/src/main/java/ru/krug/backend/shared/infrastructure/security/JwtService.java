package ru.krug.backend.shared.infrastructure.security;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * Dev-only local JWT (HS256). Keycloak replaces only the decoder/issuer adapter; the
 * application layer sees {@code TokenIssuer}.
 */
@Component
@Profile({"dev", "test"})
public class JwtService {

    private static final int MIN_SECRET_BYTES = 32;

    private final KrugProperties.Auth auth;
    private final ClockPort clock;
    private final NimbusJwtEncoder encoder;
    private final JwtDecoder decoder;

    public JwtService(KrugProperties properties, ClockPort clock) {
        this.auth = properties.auth();
        this.clock = clock;
        this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(secretKey(auth.jwtSecret())));

        NimbusJwtDecoder nimbusDecoder = NimbusJwtDecoder
                .withSecretKey(secretKey(auth.jwtSecret()))
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
        OAuth2TokenValidator<Jwt> issuer = JwtValidators.createDefaultWithIssuer(auth.issuer());
        OAuth2TokenValidator<Jwt> audience = token -> token.getAudience().contains(auth.audience())
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(
                        new OAuth2Error("invalid_token", "Required audience is missing", null));
        nimbusDecoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(issuer, audience));
        this.decoder = nimbusDecoder;
    }

    public JwtDecoder decoder() {
        return decoder;
    }

    public IssuedToken issue(UUID userId, UUID deviceId, UUID workspaceId) {
        var issuedAt = clock.now();
        var expiresAt = issuedAt.plus(auth.accessTokenTtl());
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(auth.issuer())
                .audience(List.of(auth.audience()))
                .subject(userId.toString())
                .id(UUID.randomUUID().toString())
                .issuedAt(issuedAt)
                .expiresAt(expiresAt)
                .claim("device_id", deviceId.toString())
                .claim("workspace_id", workspaceId.toString())
                .claim("sid", UUID.randomUUID().toString())
                .build();
        JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).type("JWT").build();
        String token = encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
        return new IssuedToken(token, expiresAt);
    }

    private static SecretKey secretKey(String secret) {
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < MIN_SECRET_BYTES) {
            throw new IllegalStateException("krug.auth.jwt-secret must be at least "
                    + MIN_SECRET_BYTES + " bytes (set KRUG_AUTH_JWT_SECRET)");
        }
        return new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }
}
