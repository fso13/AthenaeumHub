package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspacePermissionRepository;

/** Native-SQL role matrix; tenant RLS applies through the workspace GUC. */
@Repository
public class WorkspacePermissionRepositoryAdapter implements WorkspacePermissionRepository {

    private final EntityManager entityManager;

    public WorkspacePermissionRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Map<Membership.Role, Map<WorkspacePermission, Boolean>> findMatrix(
            UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT role, permission, allowed
                          FROM workspace.role_permissions
                         WHERE workspace_id = ?1
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        Map<Membership.Role, Map<WorkspacePermission, Boolean>> matrix =
                new EnumMap<>(Membership.Role.class);
        for (Membership.Role role : List.of(Membership.Role.OWNER, Membership.Role.ADMIN,
                Membership.Role.MEMBER)) {
            Map<WorkspacePermission, Boolean> permissions =
                    new EnumMap<>(WorkspacePermission.class);
            for (WorkspacePermission permission : WorkspacePermission.values()) {
                permissions.put(permission, WorkspacePermission.defaultFor(role, permission));
            }
            matrix.put(role, permissions);
        }
        for (Object[] row : rows) {
            Membership.Role role = Membership.Role.valueOf((String) row[0]);
            WorkspacePermission permission = WorkspacePermission.parse((String) row[1])
                    .orElse(null);
            if (permission != null && matrix.containsKey(role)) {
                matrix.get(role).put(permission, Boolean.TRUE.equals(row[2]));
            }
        }
        // OWNER is never mutable: a direct SQL write cannot turn an owner into a lesser role.
        matrix.get(Membership.Role.OWNER).replaceAll((permission, allowed) -> true);
        return matrix;
    }

    @Override
    public void insertDefaultsIfAbsent(UUID workspaceId) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.role_permissions
                               (workspace_id, role, permission, allowed)
                        SELECT ?1, d.role, d.permission, d.allowed
                          FROM (VALUES
                                ('OWNER',  'manage_workspace',   true),
                                ('OWNER',  'manage_members',     true),
                                ('OWNER',  'manage_invites',     true),
                                ('OWNER',  'manage_permissions', true),
                                ('OWNER',  'view_audit',         true),
                                ('OWNER',  'manage_security',    true),
                                ('ADMIN',  'manage_workspace',   true),
                                ('ADMIN',  'manage_members',     true),
                                ('ADMIN',  'manage_invites',     true),
                                ('ADMIN',  'manage_permissions', true),
                                ('ADMIN',  'view_audit',         true),
                                ('ADMIN',  'manage_security',    true),
                                ('MEMBER', 'manage_workspace',   false),
                                ('MEMBER', 'manage_members',     false),
                                ('MEMBER', 'manage_invites',     false),
                                ('MEMBER', 'manage_permissions', false),
                                ('MEMBER', 'view_audit',         false),
                                ('MEMBER', 'manage_security',    false)
                          ) AS d(role, permission, allowed)
                        ON CONFLICT (workspace_id, role, permission) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .executeUpdate();
    }

    @Override
    public void update(UUID workspaceId, Membership.Role role,
                       WorkspacePermission permission, boolean allowed) {
        entityManager.createNativeQuery("""
                        UPDATE workspace.role_permissions
                           SET allowed = ?4,
                               updated_at = now()
                         WHERE workspace_id = ?1
                           AND role = ?2
                           AND permission = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, role.name())
                .setParameter(3, permission.apiName())
                .setParameter(4, allowed)
                .executeUpdate();
    }

    @Override
    public boolean isAllowed(UUID workspaceId, Membership.Role role,
                             WorkspacePermission permission) {
        if (role == Membership.Role.OWNER) {
            return true;
        }
        @SuppressWarnings("unchecked")
        List<Boolean> rows = entityManager.createNativeQuery("""
                        SELECT allowed
                          FROM workspace.role_permissions
                         WHERE workspace_id = ?1
                           AND role = ?2
                           AND permission = ?3
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, role.name())
                .setParameter(3, permission.apiName())
                .getResultList();
        return rows.stream().findFirst()
                .orElseGet(() -> WorkspacePermission.defaultFor(role, permission));
    }
}
