package ru.krug.backend.workspace.application.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.domain.model.WorkspaceDeletionResult;
import ru.krug.backend.workspace.domain.model.WorkspaceLeaveResult;

/**
 * Maps the V55 lifecycle outcomes to the transport-neutral errors used by the rest of the
 * workspace surface. A foreign or unknown workspace always answers the same {@code 403}
 * {@code FORBIDDEN}, so neither membership nor existence is disclosed.
 */
public final class WorkspaceLifecycleErrors {

    private WorkspaceLifecycleErrors() {
    }

    public static void throwIfFailed(WorkspaceLeaveResult result) {
        switch (result.outcome()) {
            case OK, ALREADY_LEFT -> {
                // No-op success; the caller decides whether an audit event is needed.
            }
            case FORBIDDEN -> throw DomainException.forbidden("No access to this workspace");
            case LAST_OWNER -> throw DomainException.conflict(ErrorCode.LAST_OWNER,
                    "The last workspace owner cannot leave",
                    Map.of("field", "workspace_id"));
        }
    }

    public static void throwIfFailed(WorkspaceDeletionResult result) {
        switch (result.outcome()) {
            case OK, ALREADY_DELETED -> {
                // ALREADY_DELETED is the idempotent replay, not an error.
            }
            case FORBIDDEN -> throw DomainException.forbidden("No access to this workspace");
            case NOT_OWNER -> throw DomainException.forbidden(
                    ErrorCode.WORKSPACE_PERMISSION_DENIED,
                    "Only the workspace OWNER can delete it",
                    Map.of("permission", "manage_workspace"));
        }
    }
}
