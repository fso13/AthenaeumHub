package ru.krug.backend.auth.api;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.AvatarUpdateRequest;
import ru.krug.backend.auth.api.dto.MeResponse;
import ru.krug.backend.auth.api.dto.ProfileAvatarResponse;
import ru.krug.backend.auth.api.mapper.AuthApiMapper;
import ru.krug.backend.auth.application.model.ProfileAvatarView;
import ru.krug.backend.auth.application.usecase.ProfileAvatarService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Self-service avatar (P0-4 / #82).
 *
 * <pre>
 * POST   /me/avatar — reference an existing CLEAN image attachment owned by the caller
 * DELETE /me/avatar — idempotent clear
 * GET    /me/avatar — 302 to a 5-minute presigned object URL
 * </pre>
 */
@RestController
@RequestMapping("/api/v1/me/avatar")
public class AvatarController {

    private final ProfileAvatarService avatars;

    public AvatarController(ProfileAvatarService avatars) {
        this.avatars = avatars;
    }

    @PostMapping
    public MeResponse.User set(@Valid @RequestBody AvatarUpdateRequest request,
                               Principal principal) {
        return AuthApiMapper.toAuthUser(avatars.setAvatar(principal, request.fileId()));
    }

    @DeleteMapping
    public ResponseEntity<Void> remove(Principal principal) {
        avatars.removeAvatar(principal);
        return ResponseEntity.noContent().build();
    }

    @GetMapping
    public ResponseEntity<ProfileAvatarResponse> download(Principal principal) {
        ProfileAvatarView view = avatars.download(principal);
        return ResponseEntity.status(HttpStatus.FOUND)
                .header("Location", view.url())
                .body(new ProfileAvatarResponse(view.url(), view.expiresAt()));
    }
}
