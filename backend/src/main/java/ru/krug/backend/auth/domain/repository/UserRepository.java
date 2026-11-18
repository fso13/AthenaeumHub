package ru.krug.backend.auth.domain.repository;

import java.util.Optional;
import java.util.UUID;

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
}
