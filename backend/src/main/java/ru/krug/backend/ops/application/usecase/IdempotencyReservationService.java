package ru.krug.backend.ops.application.usecase;

import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.ops.domain.model.IdempotencyKey;
import ru.krug.backend.ops.domain.repository.IdempotencyKeyRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RetentionSettings;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Idempotency-Key semantics (SYSTEM-ANALYSIS §6.6/§7.3). The replay result is resolved by
 * resource id, which is valid because B-01/B-02 resources are immutable.
 *
 * <p>B-02: the reservation is protected by a transaction-scoped advisory lock. For sends
 * the reservation, message insert, outbox row and completion share one transaction, so a
 * crash cannot leave a committed in-progress row. A concurrent duplicate fails the
 * try-lock and receives the contractual 409 + Retry-After: 1. For older two-phase callers
 * (devices/workspaces) a stale in-progress row is recovered after
 * {@code krug.retention.idempotency-in-progress-timeout} and by the scheduled cleaner.</p>
 */
@Service
public class IdempotencyReservationService implements IdempotencyPort {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyReservationService.class);

    private final TenantContext tenantContext;
    private final IdempotencyKeyRepository repository;
    private final ClockPort clock;
    private final RetentionSettings retentionSettings;

    public IdempotencyReservationService(TenantContext tenantContext,
                                         IdempotencyKeyRepository repository, ClockPort clock,
                                         RetentionSettings retentionSettings) {
        this.tenantContext = tenantContext;
        this.repository = repository;
        this.clock = clock;
        this.retentionSettings = retentionSettings;
    }

    @Override
    @Transactional
    public IdempotencyReservation reserve(Principal principal, String scope, String key,
                                          byte[] requestHash) {
        tenantContext.activate(principal);
        if (!repository.tryLockKey(principal.userId(), scope, key)) {
            throw DomainException.idempotencyInProgress();
        }

        for (int attempt = 0; attempt < 3; attempt++) {
            Instant now = clock.now();
            Optional<IdempotencyKey> existing = repository.find(principal.userId(), scope, key);
            if (existing.isEmpty()) {
                IdempotencyKey candidate = IdempotencyKey.inProgress(principal.userId(), scope,
                        key, requestHash, now);
                if (repository.insertIfAbsent(candidate)) {
                    return IdempotencyReservation.acquired();
                }
                continue;
            }

            IdempotencyKey record = existing.get();
            if (record.isExpired(now)) {
                repository.delete(principal.userId(), scope, key);
                continue;
            }
            if (!record.matches(requestHash)) {
                throw DomainException.conflict(ErrorCode.IDEMPOTENCY_KEY_REUSED,
                        "Idempotency-Key was already used with a different request body",
                        Map.of("original_request_hash",
                                HexFormat.of().formatHex(record.requestHash())));
            }
            if (record.isInProgress()) {
                Instant staleBefore = now.minus(retentionSettings.idempotencyInProgressTimeout());
                if (record.createdAt().isBefore(staleBefore)) {
                    // A pre-B-02 crash left a committed in-progress row. It is safe to take
                    // over: this transaction owns the advisory lock for the key.
                    log.warn("Recovering stale idempotency reservation scope={}", scope);
                    repository.delete(principal.userId(), scope, key);
                    continue;
                }
                throw DomainException.idempotencyInProgress();
            }
            return IdempotencyReservation.replay(record.status(), record.resourceId());
        }
        throw DomainException.internal();
    }

    @Override
    @Transactional
    public void complete(Principal principal, String scope, String key, byte[] requestHash,
                         int status, UUID resourceId) {
        tenantContext.activate(principal);
        repository.complete(IdempotencyKey.completed(principal.userId(), scope, key, requestHash,
                status, resourceId, clock.now()));
    }

    @Override
    @Transactional
    public void abandon(Principal principal, String scope, String key) {
        tenantContext.activate(principal);
        repository.delete(principal.userId(), scope, key);
    }
}
