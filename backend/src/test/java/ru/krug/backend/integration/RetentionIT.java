package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.model.RetentionReport;
import ru.krug.backend.ops.application.usecase.RetentionService;
import ru.krug.backend.realtime.application.usecase.RealtimeTicketRetentionService;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * B-02 GC: expired idempotency keys, published outbox rows older than 7 days, and
 * expired/consumed tickets older than 1 day are removed; active rows are preserved.
 */
@ActiveProfiles("test")
class RetentionIT extends IntegrationTestBase {

    private static final String SCOPE = "retention-test";

    @Autowired
    private RetentionService retentionService;

    @Autowired
    private RealtimeTicketRetentionService realtimeTicketRetentionService;

    @Test
    void purgesExpiredIdempotencyKeysAcrossUsersAndPreservesActiveRows() throws Exception {
        SessionResponse owner = devSession();
        SessionResponse otherUser = devSession();
        Instant now = Instant.now();

        String expired = key();
        String staleInProgress = key();
        String activeCompleted = key();
        String activeInProgress = key();
        String otherExpired = key();

        insertIdempotency(owner.user().id(), expired, 201, now.minusSeconds(25 * 3600),
                now.minusSeconds(3600));
        insertIdempotency(owner.user().id(), staleInProgress, null, now.minusSeconds(2 * 3600),
                now.plusSeconds(22 * 3600));
        insertIdempotency(owner.user().id(), activeCompleted, 201, now, now.plusSeconds(24 * 3600));
        insertIdempotency(owner.user().id(), activeInProgress, null, now, now.plusSeconds(24 * 3600));
        insertIdempotency(otherUser.user().id(), otherExpired, 201, now.minusSeconds(25 * 3600),
                now.minusSeconds(3600));

        RetentionReport report = retentionService.run();

        assertThat(report.idempotencyKeys()).isGreaterThanOrEqualTo(3);
        assertThat(idempotencyCount(expired)).isZero();
        assertThat(idempotencyCount(staleInProgress)).isZero();
        assertThat(idempotencyCount(otherExpired)).isZero();
        assertThat(idempotencyCount(activeCompleted)).isEqualTo(1);
        assertThat(idempotencyCount(activeInProgress)).isEqualTo(1);
    }

    @Test
    void deletesOnlyPublishedOutboxRowsOlderThanSevenDays() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        Instant now = Instant.now();
        UUID oldPublished = UUID.randomUUID();
        UUID recentPublished = UUID.randomUUID();
        UUID oldUnpublished = UUID.randomUUID();

        insertOutbox(workspaceId, oldPublished, now.minusSeconds(8 * 24 * 3600),
                now.minusSeconds(8 * 24 * 3600));
        insertOutbox(workspaceId, recentPublished, now.minusSeconds(24 * 3600),
                now.minusSeconds(24 * 3600));
        insertOutbox(workspaceId, oldUnpublished, now.minusSeconds(8 * 24 * 3600), null);

        RetentionReport report = retentionService.run();

        assertThat(report.outbox()).isGreaterThanOrEqualTo(1);
        assertThat(outboxCount(oldPublished)).isZero();
        assertThat(outboxCount(recentPublished)).isEqualTo(1);
        assertThat(outboxCount(oldUnpublished)).isEqualTo(1);
    }

    @Test
    void purgesExpiredAndConsumedTicketsOlderThanOneDayAndPreservesActiveOnes() throws Exception {
        SessionResponse session = devSession();
        Instant now = Instant.now();

        UUID expiredOld = insertTicket(session, now.minusSeconds(3 * 24 * 3600),
                now.minusSeconds(3 * 24 * 3600).plusSeconds(30), null);
        UUID consumedOld = insertTicket(session, now.minusSeconds(2 * 24 * 3600),
                now.plusSeconds(30), now.minusSeconds(2 * 24 * 3600));
        UUID active = insertTicket(session, now, now.plusSeconds(30), null);
        UUID recentlyExpired = insertTicket(session, now.minusSeconds(3600),
                now.minusSeconds(1800), null);
        UUID recentlyConsumed = insertTicket(session, now.minusSeconds(3600),
                now.plusSeconds(30), now.minusSeconds(3600));

        int deleted = realtimeTicketRetentionService.run();

        assertThat(deleted).isGreaterThanOrEqualTo(2);
        assertThat(ticketCount(expiredOld)).isZero();
        assertThat(ticketCount(consumedOld)).isZero();
        assertThat(ticketCount(active)).isEqualTo(1);
        assertThat(ticketCount(recentlyExpired)).isEqualTo(1);
        assertThat(ticketCount(recentlyConsumed)).isEqualTo(1);
    }

    private void insertIdempotency(UUID userId, String key, Integer status, Instant createdAt,
                                   Instant expiresAt) {
        migrator().update("""
                INSERT INTO ops.idempotency_keys
                       (user_id, scope, key, request_hash, status, resource_id, created_at,
                        expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, userId, SCOPE, key, new byte[]{1, 2, 3}, status,
                status == null ? null : UUID.randomUUID(), Timestamp.from(createdAt),
                Timestamp.from(expiresAt));
    }

    private int idempotencyCount(String key) {
        return migrator().queryForObject("""
                SELECT count(*) FROM ops.idempotency_keys WHERE scope = ? AND key = ?
                """, Integer.class, SCOPE, key);
    }

    private void insertOutbox(UUID workspaceId, UUID aggregateId, Instant createdAt,
                              Instant publishedAt) {
        migrator().update("""
                INSERT INTO ops.outbox
                       (workspace_id, aggregate_type, aggregate_id, event_type, event_version,
                        partition_key, payload, created_at, published_at)
                VALUES (?, 'retention-test', ?, 'retention.test', 1, ?, '{}'::jsonb, ?, ?)
                """, workspaceId, aggregateId, aggregateId.toString(),
                Timestamp.from(createdAt),
                publishedAt == null ? null : Timestamp.from(publishedAt));
    }

    private int outboxCount(UUID aggregateId) {
        return migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE aggregate_id = ?", Integer.class,
                aggregateId);
    }

    private UUID insertTicket(SessionResponse session, Instant issuedAt, Instant expiresAt,
                              Instant consumedAt) {
        UUID id = UUID.randomUUID();
        migrator().update("""
                INSERT INTO realtime.realtime_tickets
                       (id, token_hash, user_id, device_id, workspace_id, issued_at, expires_at,
                        consumed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, id, tokenHash(), session.user().id(), session.device().id(),
                session.workspace().id(), Timestamp.from(issuedAt), Timestamp.from(expiresAt),
                consumedAt == null ? null : Timestamp.from(consumedAt));
        return id;
    }

    private int ticketCount(UUID id) {
        return migrator().queryForObject(
                "SELECT count(*) FROM realtime.realtime_tickets WHERE id = ?", Integer.class, id);
    }

    private static String key() {
        return "retention-" + UUID.randomUUID();
    }

    private static String tokenHash() {
        return UUID.randomUUID().toString().replace("-", "")
                + UUID.randomUUID().toString().replace("-", "");
    }
}
