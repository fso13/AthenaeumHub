package ru.krug.backend.workspace.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.WorkspaceOverviewResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceOverviewApiMapper;
import ru.krug.backend.workspace.application.usecase.WorkspaceOverviewService;

/**
 * {@code GET /workspaces/{id}/overview} (#84): membership-scoped dashboard aggregates.
 * Any ACTIVE member may read it; the five recent audit actions are only present for
 * OWNER/ADMIN. The response never contains message text, filenames or E2EE envelopes.
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/overview")
public class WorkspaceOverviewController {

    private final WorkspaceOverviewService overview;

    public WorkspaceOverviewController(WorkspaceOverviewService overview) {
        this.overview = overview;
    }

    @GetMapping
    public WorkspaceOverviewResponse overview(@PathVariable UUID workspaceId,
                                              Principal principal) {
        return WorkspaceOverviewApiMapper.toResponse(overview.overview(principal, workspaceId));
    }
}
