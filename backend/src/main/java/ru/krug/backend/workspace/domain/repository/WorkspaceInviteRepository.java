package ru.krug.backend.workspace.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspaceInviteAcceptance;
import ru.krug.backend.workspace.domain.model.WorkspaceInvitePreview;

/**
 * Invite persistence (P0-4 / #82, #100). Only the SHA-256 token hash crosses this port; no
 * method can read a raw token back.
 */
public interface WorkspaceInviteRepository {

    void save(UUID workspaceId, WorkspaceInvite invite, String tokenHash);

    List<WorkspaceInvite> listByWorkspace(UUID workspaceId);

    Optional<WorkspaceInvite> findById(UUID workspaceId, UUID inviteId);

    boolean revoke(UUID workspaceId, UUID inviteId, Instant at);

    /**
     * Runs {@code workspace.accept_invite} for the authenticated caller. The function owns
     * workspace/expiry/max-uses/email-binding checks and the idempotent ACTIVE-member
     * answer.
     */
    WorkspaceInviteAcceptance accept(String tokenHash, UUID userId);

    /**
     * #100: anonymous preview through {@code workspace.preview_invite}. The function is the
     * only cross-tenant read for the preview URL and returns display metadata only.
     */
    WorkspaceInvitePreview preview(String tokenHash);
}
