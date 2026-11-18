package ru.krug.backend.file.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.file.api.dto.WorkspaceLimitsResponse;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.usecase.WorkspaceLimitsHandler;
import ru.krug.backend.shared.application.model.Principal;

/** GET /workspaces/{workspaceId}/limits (tagged workspaces in the contract). */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/limits")
public class WorkspaceLimitsController {

    private final WorkspaceLimitsHandler handler;

    public WorkspaceLimitsController(WorkspaceLimitsHandler handler) {
        this.handler = handler;
    }

    @GetMapping
    public WorkspaceLimitsResponse get(@PathVariable UUID workspaceId, Principal principal) {
        return FileApiMapper.toResponse(handler.limits(principal, workspaceId));
    }
}
