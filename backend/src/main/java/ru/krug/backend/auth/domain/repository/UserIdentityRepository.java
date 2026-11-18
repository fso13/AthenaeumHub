package ru.krug.backend.auth.domain.repository;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.UserIdentity;

public interface UserIdentityRepository {

    Optional<UserIdentity> findByProviderAndSubject(String provider, String subject);

    /**
     * @return true when the row was inserted, false when another transaction already
     *         created the same (provider, subject) link.
     */
    boolean insertIfAbsent(UserIdentity identity);
}
