package ru.krug.backend.auth.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.ProfileAvatars;
import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.UserProfilePort;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.error.DomainException;

@Service
public class UserProfileService implements UserProfilePort {

    private final UserRepository userRepository;

    public UserProfileService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public String displayName(UUID userId) {
        return requireProfile(userId).displayName();
    }

    @Override
    @Transactional(readOnly = true)
    public UserProfileView requireProfile(UUID userId) {
        return userRepository.findById(userId)
                .map(UserProfileService::toView)
                .orElseThrow(() -> DomainException.notFound("User not found"));
    }

    public static UserProfileView toView(User user) {
        return new UserProfileView(user.id().toString(), user.displayName().value(), user.email(),
                user.isPlatformAdmin(), user.bio().value(), user.phone().value(),
                ProfileAvatars.url(user.avatarFileId()));
    }
}
