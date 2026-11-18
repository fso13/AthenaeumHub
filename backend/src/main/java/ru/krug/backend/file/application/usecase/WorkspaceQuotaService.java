package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.QuotaExceededException;
import ru.krug.backend.file.domain.model.QuotaReservation;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.file.domain.repository.QuotaReservationRepository;
import ru.krug.backend.file.domain.repository.WorkspaceQuotaRepository;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Quota transaction boundary.
 *
 * Every mutating method locks file.workspace_usage FOR UPDATE and transitions the
 * reservation exactly once (ACTIVE -> COMMITTED, ACTIVE -> RELEASED/EXPIRED,
 * COMMITTED -> RELEASED). This is the single place where used/reserved change, which is
 * what prevents the classic double-commit on retries or message/GC races.
 */
@Service
public class WorkspaceQuotaService implements WorkspaceQuotaPort {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceQuotaService.class);

    private final WorkspaceQuotaRepository quotaRepository;
    private final QuotaReservationRepository reservationRepository;
    private final ClockPort clock;

    public WorkspaceQuotaService(WorkspaceQuotaRepository quotaRepository,
                                 QuotaReservationRepository reservationRepository,
                                 ClockPort clock) {
        this.quotaRepository = quotaRepository;
        this.reservationRepository = reservationRepository;
        this.clock = clock;
    }

    @Override
    @Transactional
    public WorkspaceLimits limits(UUID workspaceId) {
        ensureLimits(workspaceId);
        return quotaRepository.findLimits(workspaceId)
                .orElseGet(() -> WorkspaceLimits.defaults(workspaceId));
    }

    @Override
    @Transactional
    public QuotaUsage usage(UUID workspaceId) {
        quotaRepository.lockUsage(workspaceId);
        return quotaRepository.findUsage(workspaceId).orElseGet(QuotaUsage::empty);
    }

    @Override
    @Transactional
    public QuotaReservation reserve(UUID workspaceId, UUID uploadId, long sizeBytes, Instant now,
                                    Instant expiresAt) {
        ensureLimits(workspaceId);
        WorkspaceLimits limits = quotaRepository.findLimits(workspaceId)
                .orElseGet(() -> WorkspaceLimits.defaults(workspaceId));
        QuotaUsage usage = quotaRepository.lockUsage(workspaceId);
        if (!usage.canReserve(sizeBytes, limits.storageBytes())) {
            throw new QuotaExceededException(usage.used(), usage.reserved(),
                    limits.storageBytes(), sizeBytes);
        }
        QuotaUsage updated = usage.reserve(sizeBytes);
        quotaRepository.saveUsage(workspaceId, updated);
        QuotaReservation reservation = QuotaReservation.active(UUID.randomUUID(), workspaceId,
                uploadId, sizeBytes, now, expiresAt);
        reservationRepository.save(reservation);
        logThreshold(workspaceId, updated, limits);
        return reservation;
    }

    @Override
    @Transactional
    public void commit(UUID workspaceId, UUID uploadId, Instant now) {
        QuotaReservation reservation = reservationRepository.findForUpdateByUploadId(uploadId)
                .orElse(null);
        if (reservation == null || !reservation.isActive()) {
            // Retry/duplicate complete: the quota was already committed or released.
            return;
        }
        QuotaUsage usage = quotaRepository.lockUsage(workspaceId);
        QuotaUsage updated = usage.commit(reservation.sizeBytes());
        quotaRepository.saveUsage(workspaceId, updated);
        reservationRepository.save(reservation.commit(now));
        logThreshold(workspaceId, updated, limitsOrDefault(workspaceId));
    }

    @Override
    @Transactional
    public void releaseActive(UUID workspaceId, UUID uploadId, Instant now, boolean expired) {
        QuotaReservation reservation = reservationRepository.findForUpdateByUploadId(uploadId)
                .orElse(null);
        if (reservation == null || !reservation.isActive()) {
            return;
        }
        QuotaUsage usage = quotaRepository.lockUsage(workspaceId);
        quotaRepository.saveUsage(workspaceId, usage.releaseReserved(reservation.sizeBytes()));
        reservationRepository.save(expired ? reservation.expire(now) : reservation.release(now));
    }

    @Override
    @Transactional
    public void releaseCommitted(UUID workspaceId, UUID uploadId, Instant now) {
        QuotaReservation reservation = reservationRepository.findForUpdateByUploadId(uploadId)
                .orElse(null);
        if (reservation == null || !reservation.isCommitted()) {
            return;
        }
        QuotaUsage usage = quotaRepository.lockUsage(workspaceId);
        quotaRepository.saveUsage(workspaceId, usage.releaseCommitted(reservation.sizeBytes()));
        reservationRepository.save(reservation.release(now));
    }

    @Override
    @Transactional
    public int expireStaleReservations(Instant now, int limit) {
        List<QuotaReservation> expired = reservationRepository.findActiveExpired(now, limit);
        int released = 0;
        for (QuotaReservation reservation : expired) {
            releaseActive(reservation.workspaceId(), reservation.uploadId(), now, true);
            released++;
        }
        return released;
    }

    @Override
    @Transactional
    public int reconcileStorage(int limit) {
        List<UUID> workspaceIds = quotaRepository.listWorkspaceIds(limit);
        int reconciled = 0;
        for (UUID workspaceId : workspaceIds) {
            QuotaUsage usage = quotaRepository.lockUsage(workspaceId);
            long actualUsed = quotaRepository.committedAttachmentBytes(workspaceId);
            long actualReserved = quotaRepository.activeReservationBytes(workspaceId);
            if (usage.used() != actualUsed || usage.reserved() != actualReserved) {
                log.warn("file.quota.reconcile_drift workspace_id={} used={} actual_used={} "
                                + "reserved={} actual_reserved={}", workspaceId, usage.used(),
                        actualUsed, usage.reserved(), actualReserved);
                quotaRepository.saveUsage(workspaceId,
                        new QuotaUsage(actualUsed, actualReserved));
            }
            reconciled++;
        }
        return reconciled;
    }

    private void ensureLimits(UUID workspaceId) {
        if (quotaRepository.findLimits(workspaceId).isEmpty()) {
            quotaRepository.saveLimits(WorkspaceLimits.defaults(workspaceId));
        }
    }

    private WorkspaceLimits limitsOrDefault(UUID workspaceId) {
        return quotaRepository.findLimits(workspaceId)
                .orElseGet(() -> WorkspaceLimits.defaults(workspaceId));
    }

    /** §6.7: 80/95/100% thresholds. Logging is idempotent enough for single-node MVP. */
    private void logThreshold(UUID workspaceId, QuotaUsage usage, WorkspaceLimits limits) {
        long limit = limits.storageBytes();
        if (limit <= 0) {
            return;
        }
        long percent = Math.min(100, usage.total() * 100 / limit);
        int threshold = percent >= 100 ? 100 : percent >= 95 ? 95 : percent >= 80 ? 80 : 0;
        if (threshold == 0) {
            return;
        }
        log.warn("file.quota.threshold workspace_id={} threshold={} used={} reserved={} limit={}",
                workspaceId, threshold, usage.used(), usage.reserved(), limit);
    }

    // Kept for callers that need a consistent clock inside quota tests.
    Instant now() {
        return clock.now();
    }
}
