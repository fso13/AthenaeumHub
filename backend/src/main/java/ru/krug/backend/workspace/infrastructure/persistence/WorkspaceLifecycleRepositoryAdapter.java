package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceDeletionResult;
import ru.krug.backend.workspace.domain.model.WorkspaceLeaveResult;
import ru.krug.backend.workspace.domain.repository.WorkspaceLifecycleRepository;

/**
 * Calls the V55 SECURITY DEFINER lifecycle functions. One call is one statement, so the
 * actor check, last-owner protection and every write are atomic under the per-workspace
 * advisory lock; the application only maps the returned outcome and counters.
 */
@Repository
public class WorkspaceLifecycleRepositoryAdapter implements WorkspaceLifecycleRepository {

    private final EntityManager entityManager;

    public WorkspaceLifecycleRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public WorkspaceLeaveResult leave(UUID workspaceId, UUID actorId) {
        Object[] row = single("""
                SELECT outcome, role, chat_memberships_removed
                  FROM workspace.leave_workspace(CAST(?1 AS uuid), CAST(?2 AS uuid))
                """, workspaceId, actorId);
        return new WorkspaceLeaveResult(leaveOutcome((String) row[0]),
                role(row[1]), intValue(row[2]));
    }

    @Override
    public WorkspaceDeletionResult delete(UUID workspaceId, UUID actorId) {
        Object[] row = single("""
                SELECT outcome, memberships_removed, invites_revoked,
                       chat_memberships_removed, bots_disabled
                  FROM workspace.delete_workspace(CAST(?1 AS uuid), CAST(?2 AS uuid))
                """, workspaceId, actorId);
        return new WorkspaceDeletionResult(deletionOutcome((String) row[0]),
                intValue(row[1]), intValue(row[2]), intValue(row[3]), intValue(row[4]));
    }

    private Object[] single(String sql, Object... parameters) {
        var query = entityManager.createNativeQuery(sql);
        for (int index = 0; index < parameters.length; index++) {
            query.setParameter(index + 1, parameters[index]);
        }
        return (Object[]) query.getSingleResult();
    }

    private static Membership.Role role(Object value) {
        return value == null ? null : Membership.Role.valueOf((String) value);
    }

    private static int intValue(Object value) {
        return value == null ? 0 : ((Number) value).intValue();
    }

    private static WorkspaceLeaveResult.Outcome leaveOutcome(String value) {
        if (value == null) {
            throw new IllegalStateException("Workspace leave returned no outcome");
        }
        return switch (value) {
            case "OK" -> WorkspaceLeaveResult.Outcome.OK;
            case "ALREADY_LEFT" -> WorkspaceLeaveResult.Outcome.ALREADY_LEFT;
            case "FORBIDDEN" -> WorkspaceLeaveResult.Outcome.FORBIDDEN;
            case "LAST_OWNER" -> WorkspaceLeaveResult.Outcome.LAST_OWNER;
            default -> throw new IllegalStateException(
                    "Unknown workspace leave outcome: " + value);
        };
    }

    private static WorkspaceDeletionResult.Outcome deletionOutcome(String value) {
        if (value == null) {
            throw new IllegalStateException("Workspace deletion returned no outcome");
        }
        return switch (value) {
            case "OK" -> WorkspaceDeletionResult.Outcome.OK;
            case "ALREADY_DELETED" -> WorkspaceDeletionResult.Outcome.ALREADY_DELETED;
            case "FORBIDDEN" -> WorkspaceDeletionResult.Outcome.FORBIDDEN;
            case "NOT_OWNER" -> WorkspaceDeletionResult.Outcome.NOT_OWNER;
            default -> throw new IllegalStateException(
                    "Unknown workspace deletion outcome: " + value);
        };
    }
}
