package ru.krug.backend.workspace.domain.repository;

import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceDeletionResult;
import ru.krug.backend.workspace.domain.model.WorkspaceLeaveResult;

/**
 * Write side of the workspace lifecycle (#99). Each method is one SECURITY DEFINER call
 * (V55): the actor check, the last-owner rule and every write share one transaction and
 * one per-workspace advisory lock, so a concurrent add/leave/delete cannot interleave.
 */
public interface WorkspaceLifecycleRepository {

    /**
     * Removes the caller's own membership and chat participant rows.
     *
     * @param actorId must equal the transaction principal ({@code ops.current_user_id()})
     */
    WorkspaceLeaveResult leave(UUID workspaceId, UUID actorId);

    /**
     * Soft-deletes the workspace for its OWNER: memberships/invites/chat participants are
     * removed, bots are disabled, but messages and file blobs are retained.
     */
    WorkspaceDeletionResult delete(UUID workspaceId, UUID actorId);
}
