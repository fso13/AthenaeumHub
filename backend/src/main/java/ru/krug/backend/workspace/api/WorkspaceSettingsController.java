package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.UpdateWorkspaceRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceAvatarRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceSummaryResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceApiMapper;
import ru.krug.backend.workspace.application.command.UpdateWorkspaceSettingsCommand;
import ru.krug.backend.workspace.application.usecase.WorkspaceSettingsService;

/**
 * Workspace settings (P0-4 / #82), OWNER/ADMIN via the role matrix.
 *
 * <pre>
 * PATCH  /workspaces/{id}        — name/description/logo_file_id (partial)
 * POST   /workspaces/{id}/avatar — set the logo from a CLEAN image attachment
 * DELETE /workspaces/{id}/avatar — clear the logo (idempotent)
 * </pre>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}")
public class WorkspaceSettingsController {

    private final WorkspaceSettingsService settings;

    public WorkspaceSettingsController(WorkspaceSettingsService settings) {
        this.settings = settings;
    }

    @PatchMapping
    public WorkspaceSummaryResponse update(@PathVariable UUID workspaceId,
                                           @Valid @RequestBody UpdateWorkspaceRequest request,
                                           Principal principal) {
        return WorkspaceApiMapper.toResponse(settings.update(principal, workspaceId,
                new UpdateWorkspaceSettingsCommand(request.isNamePresent(), request.getName(),
                        request.isDescriptionPresent(), request.getDescription(),
                        request.isLogoPresent(), request.getLogoFileId())));
    }

    @PostMapping("/avatar")
    public WorkspaceSummaryResponse setAvatar(@PathVariable UUID workspaceId,
                                              @Valid @RequestBody WorkspaceAvatarRequest request,
                                              Principal principal) {
        return WorkspaceApiMapper.toResponse(
                settings.setLogo(principal, workspaceId, request.fileId()));
    }

    @DeleteMapping("/avatar")
    public ResponseEntity<Void> removeAvatar(@PathVariable UUID workspaceId,
                                             Principal principal) {
        settings.removeLogo(principal, workspaceId);
        return ResponseEntity.noContent().build();
    }
}
