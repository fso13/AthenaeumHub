package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberManagementRepository;

/**
 * Calls the V27 SECURITY DEFINER functions. One call is one statement, so the actor check,
 * duplicate/limit checks and the write are atomic and serialized per workspace; the
 * application only maps the returned outcome. {@code auth.users} is FORCE RLS, therefore
 * the email lookup must stay inside the database function.
 */
@Repository
public class WorkspaceMemberManagementRepositoryAdapter
        implements WorkspaceMemberManagementRepository {

    private final EntityManager entityManager;

    public WorkspaceMemberManagementRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public WorkspaceMemberMutation addMember(UUID workspaceId, UUID actorId, String email,
                                             String role) {
        Object[] row = single("""
                SELECT outcome, user_id, display_name, role, joined_at,
                       members_used, members_limit
                  FROM workspace.add_member(CAST(?1 AS uuid),
                                            CAST(?2 AS uuid),
                                            CAST(?3 AS text),
                                            CAST(?4 AS text))
                """, workspaceId, actorId, email, role);
        return new WorkspaceMemberMutation(outcome((String) row[0]), (UUID) row[1],
                (String) row[2], role(row[3]), null, JdbcInstants.toInstant(row[4]),
                intValue(row[5]), intValue(row[6]));
    }

    @Override
    public WorkspaceMemberMutation changeRole(UUID workspaceId, UUID actorId,
                                              UUID targetUserId, String role) {
        Object[] row = single("""
                SELECT outcome, user_id, display_name, role, previous_role, joined_at
                  FROM workspace.change_member_role(CAST(?1 AS uuid),
                                                    CAST(?2 AS uuid),
                                                    CAST(?3 AS uuid),
                                                    CAST(?4 AS text))
                """, workspaceId, actorId, targetUserId, role);
        return new WorkspaceMemberMutation(outcome((String) row[0]), (UUID) row[1],
                (String) row[2], role(row[3]), role(row[4]),
                JdbcInstants.toInstant(row[5]), 0, 0);
    }

    @Override
    public WorkspaceMemberMutation removeMember(UUID workspaceId, UUID actorId,
                                                UUID targetUserId) {
        Object[] row = single("""
                SELECT outcome, user_id, display_name, role
                  FROM workspace.remove_member(CAST(?1 AS uuid),
                                               CAST(?2 AS uuid),
                                               CAST(?3 AS uuid))
                """, workspaceId, actorId, targetUserId);
        return new WorkspaceMemberMutation(outcome((String) row[0]), (UUID) row[1],
                (String) row[2], role(row[3]), null, null, 0, 0);
    }

    private Object[] single(String sql, Object... parameters) {
        var query = entityManager.createNativeQuery(sql);
        for (int index = 0; index < parameters.length; index++) {
            query.setParameter(index + 1, parameters[index]);
        }
        return (Object[]) query.getSingleResult();
    }

    private static WorkspaceMemberMutation.Outcome outcome(String value) {
        if (value == null) {
            throw new IllegalStateException("Workspace member mutation returned no outcome");
        }
        return switch (value) {
            case "OK" -> WorkspaceMemberMutation.Outcome.OK;
            case "FORBIDDEN" -> WorkspaceMemberMutation.Outcome.FORBIDDEN;
            case "ROLE_FORBIDDEN" -> WorkspaceMemberMutation.Outcome.ROLE_FORBIDDEN;
            case "ROLE_INVALID" -> WorkspaceMemberMutation.Outcome.ROLE_INVALID;
            case "USER_NOT_FOUND" -> WorkspaceMemberMutation.Outcome.USER_NOT_FOUND;
            case "MEMBER_NOT_FOUND" -> WorkspaceMemberMutation.Outcome.MEMBER_NOT_FOUND;
            case "ALREADY_EXISTS" -> WorkspaceMemberMutation.Outcome.ALREADY_EXISTS;
            case "LIMIT_REACHED" -> WorkspaceMemberMutation.Outcome.LIMIT_REACHED;
            case "SELF" -> WorkspaceMemberMutation.Outcome.SELF;
            case "LAST_OWNER" -> WorkspaceMemberMutation.Outcome.LAST_OWNER;
            default -> throw new IllegalStateException(
                    "Unknown workspace member mutation outcome: " + value);
        };
    }

    private static Membership.Role role(Object value) {
        return value == null ? null : Membership.Role.valueOf((String) value);
    }

    private static int intValue(Object value) {
        return value == null ? 0 : ((Number) value).intValue();
    }
}
