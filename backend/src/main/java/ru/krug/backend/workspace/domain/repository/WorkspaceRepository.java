package ru.krug.backend.workspace.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspaceMembership;

public interface WorkspaceRepository {

    boolean isActiveMember(UUID workspaceId, UUID userId);

    Optional<Workspace> findById(UUID workspaceId);

    Optional<Membership> findMembership(UUID workspaceId, UUID userId);

    /**
     * Active memberships of a user ordered by {@code joined_at} (the first one is the
     * default workspace returned by {@code GET /me}).
     */
    List<WorkspaceMembership> listActiveMemberships(UUID userId);

    void save(Workspace workspace);

    void save(Membership membership);
}
