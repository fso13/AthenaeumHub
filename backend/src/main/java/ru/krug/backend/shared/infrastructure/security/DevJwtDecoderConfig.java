package ru.krug.backend.shared.infrastructure.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Dev-only HS256 decoder. It is intentionally absent from {@code keycloak}/{@code prod},
 * so a dev token cannot be accepted there even if the old secret is still configured.
 */
@Configuration
@Profile({"dev", "test"})
public class DevJwtDecoderConfig {

    @Bean
    public JwtDecoder jwtDecoder(JwtService jwtService) {
        return jwtService.decoder();
    }
}
