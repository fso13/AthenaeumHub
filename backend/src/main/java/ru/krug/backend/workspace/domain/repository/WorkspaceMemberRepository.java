package ru.krug.backend.workspace.domain.repository;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceMemberRow;

/**
 * Read-only member directory for a workspace. The implementation uses the V24
 * {@code workspace.member_directory} SECURITY DEFINER function because {@code auth.users}
 * is FORCE RLS (self-only); the caller must activate the tenant context first.
 */
public interface WorkspaceMemberRepository {

    /**
     * Active members of an ACTIVE workspace whose user account is ACTIVE, ordered by
     * {@code (display_name, user_id)}. A caller who is not an ACTIVE member receives an
     * empty list (defence in depth behind the application-level 403 guard).
     *
     * @param query              literal display-name substring, already normalised
     * @param cursorDisplayName  last row's display_name for the keyset, or {@code null}
     * @param cursorUserId       last row's user_id for the keyset, or {@code null}
     * @param limit              maximum rows to fetch (the service asks for limit + 1)
     */
    List<WorkspaceMemberRow> findActiveMembers(UUID workspaceId, String query,
                                               String cursorDisplayName, UUID cursorUserId,
                                               int limit);
}
