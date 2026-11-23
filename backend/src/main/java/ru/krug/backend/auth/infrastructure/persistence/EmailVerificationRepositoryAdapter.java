package ru.krug.backend.auth.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;

/** Persistence adapter: encrypts/decrypts the TOTP secret at the boundary. */
@Repository
public class EmailVerificationRepositoryAdapter implements EmailVerificationRepository {

    private final EmailVerificationJpaRepository repository;
    private final EmailCodeCipher cipher;

    public EmailVerificationRepositoryAdapter(EmailVerificationJpaRepository repository,
                                             EmailCodeCipher cipher) {
        this.repository = repository;
        this.cipher = cipher;
    }

    @Override
    public Optional<EmailVerification> findById(UUID id) {
        return repository.findById(id).map(this::toDomain);
    }

    @Override
    public Optional<EmailVerification> findByIdForUpdate(UUID id) {
        return repository.lockById(id).map(this::toDomain);
    }

    @Override
    public Optional<EmailVerification> findLatestActiveByEmail(String email, Instant now) {
        return repository
                .findFirstByEmailIgnoreCaseAndConsumedAtIsNullAndExpiresAtAfterOrderByCreatedAtDesc(
                        email, now)
                .map(this::toDomain);
    }

    @Override
    public void save(EmailVerification verification) {
        repository.save(toEntity(verification));
    }

    @Override
    public void delete(UUID id) {
        repository.deleteById(id);
    }

    @Override
    @Transactional
    public int markConsumed(UUID id, Instant now) {
        return repository.markConsumed(id, now);
    }

    @Override
    public List<EmailVerification> findExpiredUnconsumed(Instant now, int limit) {
        return repository
                .findByExpiresAtBeforeAndConsumedAtIsNullOrderByExpiresAtAsc(now,
                        PageRequest.of(0, Math.max(1, limit)))
                .stream().map(this::toDomain).toList();
    }

    @Override
    @Transactional
    public int deleteConsumedBefore(Instant cutoff, int limit) {
        return repository.deleteConsumedBefore(cutoff, Math.max(1, limit));
    }

    private EmailVerification toDomain(EmailVerificationEntity entity) {
        return EmailVerification.reconstitute(
                entity.getId(),
                entity.getEmail(),
                entity.getDisplayName(),
                entity.getKeycloakUserId(),
                cipher.decrypt(entity.getSecret(), entity.getId(), entity.getEmail()),
                entity.getExpiresAt(),
                entity.getAttempts(),
                entity.getConsumedAt(),
                entity.getLastSentAt(),
                entity.getCreatedAt(),
                entity.getInviteTokenHash());
    }

    private EmailVerificationEntity toEntity(EmailVerification verification) {
        EmailVerificationEntity entity = new EmailVerificationEntity();
        entity.setId(verification.id());
        entity.setEmail(verification.email());
        entity.setDisplayName(verification.displayName());
        entity.setKeycloakUserId(verification.keycloakUserId());
        entity.setSecret(cipher.encrypt(verification.secret(), verification.id(),
                verification.email()));
        entity.setExpiresAt(verification.expiresAt());
        entity.setAttempts(verification.attempts());
        entity.setConsumedAt(verification.consumedAt());
        entity.setLastSentAt(verification.lastSentAt());
        entity.setInviteTokenHash(verification.inviteTokenHash());
        return entity;
    }
}
