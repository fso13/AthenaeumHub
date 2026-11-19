package ru.krug.backend.auth.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.MeResponse;
import ru.krug.backend.auth.api.dto.ProfileSessionsResponse;
import ru.krug.backend.auth.api.dto.UpdateProfileRequest;
import ru.krug.backend.auth.api.mapper.AuthApiMapper;
import ru.krug.backend.auth.application.usecase.MeQueryService;
import ru.krug.backend.auth.application.usecase.ProfileSessionService;
import ru.krug.backend.auth.application.usecase.UpdateProfileService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Self-service profile endpoints. All operations act on the authenticated caller only;
 * there is no user id in any path. Keycloak session endpoints are intentionally not
 * device-bound: an expired device must still be able to list and revoke sessions.
 */
@RestController
@RequestMapping("/api/v1")
public class MeController {

    private final MeQueryService meQueryService;
    private final UpdateProfileService updateProfileService;
    private final ProfileSessionService profileSessionService;

    public MeController(MeQueryService meQueryService,
                        UpdateProfileService updateProfileService,
                        ProfileSessionService profileSessionService) {
        this.meQueryService = meQueryService;
        this.updateProfileService = updateProfileService;
        this.profileSessionService = profileSessionService;
    }

    @GetMapping("/me")
    public MeResponse me(Principal principal) {
        return AuthApiMapper.toResponse(meQueryService.me(principal));
    }

    @PatchMapping("/me")
    public MeResponse.User updateProfile(@Valid @RequestBody UpdateProfileRequest request,
                                         Principal principal) {
        return AuthApiMapper.toAuthUser(updateProfileService.update(principal,
                AuthApiMapper.toCommand(request)));
    }

    @GetMapping("/me/sessions")
    public ProfileSessionsResponse sessions(Principal principal) {
        return AuthApiMapper.toSessionsResponse(profileSessionService.list(principal));
    }

    @DeleteMapping("/me/sessions/{sessionId}")
    public ResponseEntity<Void> revokeSession(@PathVariable UUID sessionId,
                                              Principal principal) {
        profileSessionService.revoke(principal, sessionId.toString());
        return ResponseEntity.noContent().build();
    }
}
