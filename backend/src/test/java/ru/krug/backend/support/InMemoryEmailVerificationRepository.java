package ru.krug.backend.support;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;

/** In-memory repository for application/use-case tests (no Spring, no PostgreSQL). */
public class InMemoryEmailVerificationRepository implements EmailVerificationRepository {

    private final Map<UUID, EmailVerification> rows = new ConcurrentHashMap<>();

    @Override
    public Optional<EmailVerification> findById(UUID id) {
        return Optional.ofNullable(rows.get(id));
    }

    @Override
    public Optional<EmailVerification> findByIdForUpdate(UUID id) {
        return findById(id);
    }

    @Override
    public Optional<EmailVerification> findLatestActiveByEmail(String email, Instant now) {
        return rows.values().stream()
                .filter(row -> row.email().equalsIgnoreCase(email))
                .filter(row -> !row.isConsumed() && !row.isExpired(now))
                .max(Comparator.comparing(EmailVerification::createdAt));
    }

    @Override
    public void save(EmailVerification verification) {
        rows.put(verification.id(), verification);
    }

    @Override
    public void delete(UUID id) {
        rows.remove(id);
    }

    @Override
    public int markConsumed(UUID id, Instant now) {
        EmailVerification row = rows.get(id);
        if (row == null || row.isConsumed()) {
            return 0;
        }
        rows.put(id, row.consumed(now));
        return 1;
    }

    @Override
    public List<EmailVerification> findExpiredUnconsumed(Instant now, int limit) {
        return rows.values().stream()
                .filter(row -> !row.isConsumed() && row.isExpired(now))
                .limit(Math.max(1, limit))
                .toList();
    }

    @Override
    public int deleteConsumedBefore(Instant cutoff, int limit) {
        List<UUID> ids = rows.values().stream()
                .filter(row -> row.consumedAt() != null && row.consumedAt().isBefore(cutoff))
                .limit(Math.max(1, limit))
                .map(EmailVerification::id)
                .toList();
        ids.forEach(rows::remove);
        return ids.size();
    }

    public EmailVerification row(UUID id) {
        return rows.get(id);
    }

    public int size() {
        return rows.size();
    }
}
