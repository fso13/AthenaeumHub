package ru.krug.backend.ops.infrastructure.persistence;

import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.repository.AdminSessionDirectory;

/**
 * Calls the V49 {@code ops.admin_user_subject} SECURITY DEFINER lookup. The function
 * verifies that the caller is an ACTIVE platform admin and returns only the opaque subject.
 */
@Repository
public class AdminSessionDirectoryAdapter implements AdminSessionDirectory {

    private final EntityManager entityManager;

    public AdminSessionDirectoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<String> findKeycloakSubject(UUID userId, UUID callerId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT ops.admin_user_subject(CAST(?1 AS uuid), CAST(?2 AS uuid))
                        """)
                .setParameter(1, userId)
                .setParameter(2, callerId)
                .getResultList();
        return rows.stream().filter(Objects::nonNull).findFirst().map(Object::toString);
    }
}
