package ru.krug.backend.auth.api;

import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.ProfileAvatarResponse;
import ru.krug.backend.auth.application.model.ProfileAvatarView;
import ru.krug.backend.auth.application.usecase.ProfileAvatarService;
import ru.krug.backend.shared.application.model.Principal;

/** #109: authenticated avatar read for another user; 404 hides unset avatars. */
@RestController
@RequestMapping("/api/v1/users/{userId}/avatar")
public class UserAvatarController {

    private final ProfileAvatarService avatars;

    public UserAvatarController(ProfileAvatarService avatars) {
        this.avatars = avatars;
    }

    @GetMapping
    public ResponseEntity<ProfileAvatarResponse> download(@PathVariable UUID userId,
                                                          Principal principal) {
        ProfileAvatarView view = avatars.downloadUser(principal, userId);
        return ResponseEntity.status(HttpStatus.FOUND)
                .header("Location", view.url())
                .body(new ProfileAvatarResponse(view.url(), view.expiresAt()));
    }
}
