package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.UpdateWorkspaceSecurityRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceSecurityResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceSecurityApiMapper;
import ru.krug.backend.workspace.application.usecase.WorkspaceSecuritySettingsService;

/**
 * Workspace security settings (P0-3 / #81). OWNER/ADMIN only.
 *
 * <pre>
 * GET   /workspaces/{id}/security
 * PATCH /workspaces/{id}/security
 * </pre>
 *
 * <p>The workspace security mode is immutable: an explicit {@code security_mode} in the
 * PATCH body is rejected with {@code 422 MODE_CHANGE_FORBIDDEN}, never silently ignored.
 * DLP cannot be enabled for an E2EE workspace.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/security")
public class WorkspaceSecurityController {

    private final WorkspaceSecuritySettingsService settings;

    public WorkspaceSecurityController(WorkspaceSecuritySettingsService settings) {
        this.settings = settings;
    }

    @GetMapping
    public WorkspaceSecurityResponse get(@PathVariable UUID workspaceId,
                                         Principal principal) {
        return WorkspaceSecurityApiMapper.toResponse(settings.get(principal, workspaceId));
    }

    @PatchMapping
    public WorkspaceSecurityResponse update(
            @PathVariable UUID workspaceId,
            @Valid @RequestBody UpdateWorkspaceSecurityRequest request,
            Principal principal) {
        return WorkspaceSecurityApiMapper.toResponse(settings.update(principal, workspaceId,
                WorkspaceSecurityApiMapper.toCommand(request)));
    }
}
