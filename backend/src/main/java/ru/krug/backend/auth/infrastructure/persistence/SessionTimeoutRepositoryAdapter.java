package ru.krug.backend.auth.infrastructure.persistence;

import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.repository.SessionTimeoutRepository;

/**
 * Calls the narrow {@code workspace.effective_session_timeout_minutes(uuid)} SECURITY
 * DEFINER function. The function returns only an integer and re-checks that the argument
 * equals the current transaction user, so it cannot be used to probe another user.
 */
@Repository
public class SessionTimeoutRepositoryAdapter implements SessionTimeoutRepository {

    private final EntityManager entityManager;

    public SessionTimeoutRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public int effectiveTimeoutMinutes(UUID userId) {
        Number value = (Number) entityManager.createNativeQuery("""
                        SELECT workspace.effective_session_timeout_minutes(?1)
                        """)
                .setParameter(1, userId)
                .getSingleResult();
        return value == null ? 0 : value.intValue();
    }
}
