package ru.krug.backend.workspace.domain.repository;

import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;

/**
 * Write side of workspace member management (E12-B). Every method is one SECURITY DEFINER
 * call: actor authorization, duplicate/limit checks and the write share one transaction and
 * one per-workspace advisory lock. {@code auth.users} is FORCE RLS, so the email lookup for
 * {@link #addMember} must happen inside that function; the application never reads another
 * user's row directly.
 */
public interface WorkspaceMemberManagementRepository {

    /**
     * Adds an existing ACTIVE user selected by email.
     *
     * @param role one of ADMIN/MEMBER/GUEST; OWNER is rejected by the database as well
     */
    WorkspaceMemberMutation addMember(UUID workspaceId, UUID actorId, String email,
                                      String role);

    /** Changes an ACTIVE member's role; OWNER is never assignable. */
    WorkspaceMemberMutation changeRole(UUID workspaceId, UUID actorId, UUID targetUserId,
                                       String role);

    /** Soft-removes an ACTIVE member ({@code status = 'REMOVED'}). */
    WorkspaceMemberMutation removeMember(UUID workspaceId, UUID actorId, UUID targetUserId);
}
