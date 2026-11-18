package ru.krug.backend.auth.infrastructure.persistence;

import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.User;

public final class UserPersistenceMapper {

    private UserPersistenceMapper() {
    }

    public static User toDomain(UserEntity entity) {
        return User.reconstitute(entity.getId(), entity.getEmail(),
                new DisplayName(entity.getDisplayName()),
                User.Status.valueOf(entity.getStatus()), entity.isPlatformAdmin());
    }
}
