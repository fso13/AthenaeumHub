package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.CreateDlpPolicyRequest;
import ru.krug.backend.workspace.api.dto.DlpEventPageResponse;
import ru.krug.backend.workspace.api.dto.DlpPolicyListResponse;
import ru.krug.backend.workspace.api.dto.DlpPolicyResponse;
import ru.krug.backend.workspace.api.dto.UpdateDlpPolicyRequest;
import ru.krug.backend.workspace.api.mapper.WorkspaceSecurityApiMapper;
import ru.krug.backend.workspace.application.usecase.DlpEventQueryService;
import ru.krug.backend.workspace.application.usecase.DlpPolicyService;

/**
 * Workspace DLP policy CRUD and content-free event query (P0-3 / #81).
 *
 * <pre>
 * GET    /workspaces/{id}/dlp/policies
 * POST   /workspaces/{id}/dlp/policies
 * PATCH  /workspaces/{id}/dlp/policies/{policyId}
 * DELETE /workspaces/{id}/dlp/policies/{policyId}
 * GET    /workspaces/{id}/dlp/events
 * </pre>
 *
 * <p>The controller stays thin: OWNER/ADMIN authorization, E2EE rejection, bounded literal
 * validation, limits and audit live in the application use cases.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/dlp")
public class WorkspaceDlpController {

    private final DlpPolicyService policies;
    private final DlpEventQueryService events;

    public WorkspaceDlpController(DlpPolicyService policies, DlpEventQueryService events) {
        this.policies = policies;
        this.events = events;
    }

    @GetMapping("/policies")
    public DlpPolicyListResponse listPolicies(@PathVariable UUID workspaceId,
                                             Principal principal) {
        return WorkspaceSecurityApiMapper.toResponse(policies.list(principal, workspaceId));
    }

    @PostMapping("/policies")
    public ResponseEntity<DlpPolicyResponse> createPolicy(
            @PathVariable UUID workspaceId,
            @Valid @RequestBody CreateDlpPolicyRequest request,
            Principal principal) {
        return ResponseEntity.status(201).body(WorkspaceSecurityApiMapper.toResponse(
                policies.create(principal, workspaceId,
                        WorkspaceSecurityApiMapper.toCommand(request))));
    }

    @PatchMapping("/policies/{policyId}")
    public DlpPolicyResponse updatePolicy(
            @PathVariable UUID workspaceId,
            @PathVariable UUID policyId,
            @Valid @RequestBody UpdateDlpPolicyRequest request,
            Principal principal) {
        return WorkspaceSecurityApiMapper.toResponse(policies.update(principal, workspaceId,
                policyId, WorkspaceSecurityApiMapper.toCommand(request)));
    }

    @DeleteMapping("/policies/{policyId}")
    public ResponseEntity<Void> deletePolicy(
            @PathVariable UUID workspaceId,
            @PathVariable UUID policyId,
            Principal principal) {
        policies.delete(principal, workspaceId, policyId);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/events")
    public DlpEventPageResponse listEvents(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "policy_id", required = false) UUID policyId,
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return WorkspaceSecurityApiMapper.toPage(
                events.list(principal, workspaceId, policyId, action, cursor, limit));
    }
}
