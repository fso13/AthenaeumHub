package ru.krug.backend.shared.infrastructure.persistence;

import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Sets transaction-local PostgreSQL GUCs consumed by RLS policies. Lives in
 * infrastructure; callers (application handlers) only know the port.
 */
@Component
public class JpaTenantContext implements TenantContext {

    private final EntityManager entityManager;

    public JpaTenantContext(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void activate(Principal principal) {
        entityManager.createNativeQuery("""
                        SELECT set_config('app.user_id', ?1, true),
                               set_config('app.workspace_id', ?2, true),
                               set_config('app.request_id', ?3, true),
                               set_config('app.worker_role', '', true)
                        """)
                .setParameter(1, value(principal.userId()))
                .setParameter(2, value(principal.workspaceId()))
                .setParameter(3, principal.requestId() == null ? "" : principal.requestId())
                .getSingleResult();
    }

    private static String value(UUID uuid) {
        return uuid == null ? "" : uuid.toString();
    }
}
