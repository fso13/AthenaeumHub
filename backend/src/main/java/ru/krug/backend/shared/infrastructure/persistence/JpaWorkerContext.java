package ru.krug.backend.shared.infrastructure.persistence;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Sets the transaction-local worker role consumed by the ops RLS policies. The role is a
 * deliberate, narrow privilege for the outbox relay and the retention cleaner; every other
 * transaction runs with tenant scoping only.
 */
@Component
public class JpaWorkerContext implements WorkerContext {

    private final EntityManager entityManager;

    public JpaWorkerContext(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void activate(WorkerRole role) {
        entityManager.createNativeQuery("""
                        SELECT set_config('app.worker_role', ?1, true),
                               set_config('app.user_id', '', true),
                               set_config('app.workspace_id', '', true),
                               set_config('app.request_id', ?2, true)
                        """)
                .setParameter(1, role.setting())
                .setParameter(2, "worker:" + role.setting())
                .getSingleResult();
    }
}
