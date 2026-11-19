package ru.krug.backend.auth.infrastructure.persistence;

import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;

@Repository
public class UserIdentityRepositoryAdapter implements UserIdentityRepository {

    private final EntityManager entityManager;

    public UserIdentityRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<UserIdentity> findByProviderAndSubject(String provider, String subject) {
        @SuppressWarnings("unchecked")
        java.util.List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, user_id, provider, subject
                          FROM auth.user_identities
                         WHERE provider = ?1 AND subject = ?2
                        """)
                .setParameter(1, provider)
                .setParameter(2, subject)
                .getResultList();
        return rows.stream().findFirst().map(row -> new UserIdentity(
                (UUID) row[0], (UUID) row[1], (String) row[2], (String) row[3]));
    }

    @Override
    public Optional<UserIdentity> findByUserIdAndProvider(UUID userId, String provider) {
        @SuppressWarnings("unchecked")
        java.util.List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, user_id, provider, subject
                          FROM auth.user_identities
                         WHERE user_id = ?1 AND provider = ?2
                        """)
                .setParameter(1, userId)
                .setParameter(2, provider)
                .getResultList();
        return rows.stream().findFirst().map(row -> new UserIdentity(
                (UUID) row[0], (UUID) row[1], (String) row[2], (String) row[3]));
    }

    @Override
    public boolean insertIfAbsent(UserIdentity identity) {
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO auth.user_identities (id, user_id, provider, subject)
                        VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT (provider, subject) DO NOTHING
                        """)
                .setParameter(1, identity.id())
                .setParameter(2, identity.userId())
                .setParameter(3, identity.provider())
                .setParameter(4, identity.subject())
                .executeUpdate();
        return inserted == 1;
    }
}
