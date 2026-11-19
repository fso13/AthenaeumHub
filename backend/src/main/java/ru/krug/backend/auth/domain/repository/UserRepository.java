package ru.krug.backend.auth.domain.repository;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.Bio;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.Phone;
import ru.krug.backend.auth.domain.model.User;

public interface UserRepository {

    Optional<User> findById(UUID id);

    Optional<User> findByEmail(String email);

    /** Status-only lookup for login; SECURITY DEFINER avoids widening auth.users RLS. */
    Optional<String> findStatusByEmail(String email);

    /**
     * Atomically answers whether the caller must be the first platform admin. The check is
     * serialized by a transaction-scoped advisory lock in PostgreSQL, so two concurrent
     * first logins cannot both receive {@code true}. Must be called inside the transaction
     * that inserts the user.
     */
    boolean claimPlatformAdmin();

    void save(User user);

    /**
     * Self-service profile write. Only the three profile columns are touched:
     * email/password/status/platform-admin and E2EE device keys are never changed here.
     * The caller's RLS context must be active.
     */
    void updateProfile(UUID userId, DisplayName displayName, Bio bio, Phone phone);
}
