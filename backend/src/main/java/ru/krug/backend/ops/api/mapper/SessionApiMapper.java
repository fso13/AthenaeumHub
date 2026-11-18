package ru.krug.backend.ops.api.mapper;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.model.SessionResult;

public final class SessionApiMapper {

    private SessionApiMapper() {
    }

    public static SessionResponse toResponse(SessionResult result) {
        return new SessionResponse(
                result.accessToken(),
                result.expiresAt(),
                new SessionResponse.UserInfo(result.user().id(), result.user().displayName()),
                new SessionResponse.DeviceInfo(result.device().id(), result.device().platform()),
                new SessionResponse.WorkspaceInfo(result.workspace().id(), result.workspace().name(),
                        result.workspace().securityMode()),
                new SessionResponse.ChatInfo(result.chat().id(), result.chat().name(),
                        result.chat().type()));
    }
}
