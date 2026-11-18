package ru.krug.backend.shared.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.IssuedToken;

public interface TokenIssuer {

    IssuedToken issue(UUID userId, UUID deviceId, UUID workspaceId);
}
