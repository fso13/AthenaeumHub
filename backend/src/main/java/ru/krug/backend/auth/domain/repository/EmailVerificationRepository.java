package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.EmailVerification;

/** Persistence port for pre-auth email confirmations. */
public interface EmailVerificationRepository {

    Optional<EmailVerification> findById(UUID id);

    /** Pessimistic row lock; must be called inside a transaction. */
    Optional<EmailVerification> findByIdForUpdate(UUID id);

    Optional<EmailVerification> findLatestActiveByEmail(String email, Instant now);

    void save(EmailVerification verification);

    void delete(UUID id);

    /** Atomically marks the row consumed; returns 1 when this caller won the race. */
    int markConsumed(UUID id, Instant now);

    List<EmailVerification> findExpiredUnconsumed(Instant now, int limit);

    int deleteConsumedBefore(Instant cutoff, int limit);
}
