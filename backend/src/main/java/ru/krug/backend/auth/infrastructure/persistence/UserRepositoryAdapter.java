package ru.krug.backend.auth.infrastructure.persistence;

import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.Bio;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.Phone;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.error.DomainException;

@Repository
public class UserRepositoryAdapter implements UserRepository {

    private final UserJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public UserRepositoryAdapter(UserJpaRepository jpaRepository, EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public Optional<User> findById(UUID id) {
        return jpaRepository.findById(id).map(UserPersistenceMapper::toDomain);
    }

    @Override
    public Optional<String> findStatusByEmail(String email) {
        if (email == null || email.isBlank()) {
            return Optional.empty();
        }
        @SuppressWarnings("unchecked")
        java.util.List<String> rows = entityManager.createNativeQuery(
                        "SELECT ops.lookup_user_status_by_email(?1)")
                .setParameter(1, email)
                .getResultList();
        return rows.stream().filter(java.util.Objects::nonNull).findFirst();
    }

    @Override
    public Optional<User> findByEmail(String email) {
        if (email == null || email.isBlank()) {
            return Optional.empty();
        }
        @SuppressWarnings("unchecked")
        java.util.List<UserEntity> rows = entityManager.createQuery("""
                        SELECT u FROM UserEntity u WHERE lower(u.email) = lower(?1)
                        """, UserEntity.class)
                .setParameter(1, email)
                .setMaxResults(1)
                .getResultList();
        return rows.stream().findFirst().map(UserPersistenceMapper::toDomain);
    }

    /**
     * Idempotent dev upsert. Implemented as a native statement because the use case is
     * "insert or keep existing tenancy", which JPA merge cannot express atomically.
     *
     * <p>The platform-admin flag is additive on conflict: a repeated provision never
     * demotes an existing first admin, while a successful claim promotes the row.</p>
     */
    @Override
    public void save(User user) {
        entityManager.createNativeQuery("""
                        INSERT INTO auth.users
                               (id, email, display_name, status, is_platform_admin)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (id) DO UPDATE
                           SET email = EXCLUDED.email,
                               display_name = EXCLUDED.display_name,
                               is_platform_admin = auth.users.is_platform_admin
                                   OR EXCLUDED.is_platform_admin,
                               updated_at = now()
                        """)
                .setParameter(1, user.id())
                .setParameter(2, user.email())
                .setParameter(3, user.displayName().value())
                .setParameter(4, user.status().name())
                .setParameter(5, user.isPlatformAdmin())
                .executeUpdate();
    }

    @Override
    public void updateProfile(UUID userId, DisplayName displayName, Bio bio, Phone phone) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE auth.users
                           SET display_name = ?2,
                               bio = ?3,
                               phone = ?4,
                               updated_at = now()
                         WHERE id = ?1
                        """)
                .setParameter(1, userId)
                .setParameter(2, displayName.value())
                .setParameter(3, bio == null ? null : bio.value())
                .setParameter(4, phone == null ? null : phone.value())
                .executeUpdate();
        if (updated == 0) {
            // The row disappeared between the read and the write (or RLS hid it).
            throw DomainException.notFound("User not found");
        }
    }

    @Override
    public boolean claimPlatformAdmin() {
        Boolean claim = (Boolean) entityManager.createNativeQuery(
                        "SELECT auth.claim_platform_admin()")
                .getSingleResult();
        return Boolean.TRUE.equals(claim);
    }
}
