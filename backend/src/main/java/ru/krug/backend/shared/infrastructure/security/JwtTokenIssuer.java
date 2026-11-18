package ru.krug.backend.shared.infrastructure.security;

import java.util.UUID;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;

@Component
@Profile({"dev", "test"})
public class JwtTokenIssuer implements TokenIssuer {

    private final JwtService jwtService;

    public JwtTokenIssuer(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    public IssuedToken issue(UUID userId, UUID deviceId, UUID workspaceId) {
        return jwtService.issue(userId, deviceId, workspaceId);
    }
}
