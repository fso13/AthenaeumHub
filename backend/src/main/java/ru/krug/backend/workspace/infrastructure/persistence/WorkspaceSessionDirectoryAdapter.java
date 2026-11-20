package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.WorkspaceMemberIdentity;
import ru.krug.backend.workspace.domain.repository.WorkspaceSessionDirectory;

/**
 * Calls the V42 {@code workspace.security_member_subjects} function. The function itself
 * re-checks that the caller is an ACTIVE OWNER/ADMIN, so this adapter cannot widen the
 * visibility of {@code auth.user_identities}.
 */
@Repository
public class WorkspaceSessionDirectoryAdapter implements WorkspaceSessionDirectory {

    private final EntityManager entityManager;

    public WorkspaceSessionDirectoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<WorkspaceMemberIdentity> findKeycloakMembers(UUID workspaceId, UUID callerId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT user_id, keycloak_subject
                          FROM workspace.security_member_subjects(
                                   CAST(?1 AS uuid), CAST(?2 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, callerId)
                .getResultList();
        return rows.stream().map(row -> new WorkspaceMemberIdentity((UUID) row[0],
                (String) row[1])).toList();
    }
}
