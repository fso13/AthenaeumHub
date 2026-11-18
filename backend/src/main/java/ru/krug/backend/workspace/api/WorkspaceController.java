package ru.krug.backend.workspace.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.CreateWorkspaceRequest;
import ru.krug.backend.workspace.api.dto.WorkspaceSummaryResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceApiMapper;
import ru.krug.backend.workspace.application.command.CreateWorkspaceCommand;
import ru.krug.backend.workspace.application.model.CreateWorkspaceResult;
import ru.krug.backend.workspace.application.usecase.CreateWorkspaceUseCase;

@RestController
@RequestMapping("/api/v1")
public class WorkspaceController {

    private final CreateWorkspaceUseCase createWorkspaceUseCase;

    public WorkspaceController(CreateWorkspaceUseCase createWorkspaceUseCase) {
        this.createWorkspaceUseCase = createWorkspaceUseCase;
    }

    @PostMapping("/workspaces")
    public ResponseEntity<WorkspaceSummaryResponse> create(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody CreateWorkspaceRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        CreateWorkspaceResult result = createWorkspaceUseCase.create(principal, key,
                new CreateWorkspaceCommand(request.name(), request.securityMode()));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(result.status());
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(WorkspaceApiMapper.toResponse(result.workspace()));
    }
}
