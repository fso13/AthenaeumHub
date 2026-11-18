package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.WorkspaceMemberRow;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberRepository;

/**
 * Reads the V24 {@code workspace.member_directory} SECURITY DEFINER function. One page is
 * a single SQL statement (no per-member round trips); the function itself verifies the
 * caller's ACTIVE membership and projects only user_id/display_name/role/joined_at.
 */
@Repository
public class WorkspaceMemberRepositoryAdapter implements WorkspaceMemberRepository {

    private final EntityManager entityManager;

    public WorkspaceMemberRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<WorkspaceMemberRow> findActiveMembers(UUID workspaceId, String query,
                                                      String cursorDisplayName,
                                                      UUID cursorUserId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT user_id, display_name, role, joined_at
                          FROM workspace.member_directory(CAST(?1 AS uuid),
                                                          CAST(?2 AS text),
                                                          CAST(?3 AS integer),
                                                          CAST(?4 AS text),
                                                          CAST(?5 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, query)
                .setParameter(3, limit)
                .setParameter(4, cursorDisplayName)
                .setParameter(5, cursorUserId)
                .getResultList();
        return rows.stream()
                .map(row -> new WorkspaceMemberRow((UUID) row[0], (String) row[1],
                        (String) row[2], JdbcInstants.toInstant(row[3])))
                .toList();
    }

}
