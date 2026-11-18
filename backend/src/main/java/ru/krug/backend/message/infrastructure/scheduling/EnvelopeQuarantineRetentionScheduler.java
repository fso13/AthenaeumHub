package ru.krug.backend.message.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * E7-B3F3 P2-11: bounded retention for the V19 envelope quarantine.
 *
 * <p>The runtime role has no privilege on {@code message.message_envelopes_quarantine}; it
 * may only execute the SECURITY DEFINER function created by V20. The function validates the
 * window and returns the number of deleted rows, so this job never reads ciphertext or
 * metadata. The first run is delayed past startup (migrations and a possible rolling deploy)
 * and the feature can be disabled with
 * {@code krug.e2ee.quarantine-retention-enabled=false}.
 */
@Component
public class EnvelopeQuarantineRetentionScheduler {

    private static final Logger log =
            LoggerFactory.getLogger(EnvelopeQuarantineRetentionScheduler.class);

    private final JdbcTemplate jdbc;
    private final KrugProperties properties;

    public EnvelopeQuarantineRetentionScheduler(JdbcTemplate jdbc, KrugProperties properties) {
        this.jdbc = jdbc;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${krug.e2ee.quarantine-retention-poll-interval:24h}",
            initialDelayString = "${krug.e2ee.quarantine-retention-initial-delay:1h}")
    public void purgeExpiredQuarantine() {
        KrugProperties.E2ee e2ee = properties.e2ee();
        if (e2ee == null || !e2ee.quarantineRetentionEnabled()) {
            return;
        }
        Integer deleted = jdbc.queryForObject(
                "SELECT message.purge_envelope_quarantine(?)", Integer.class,
                e2ee.quarantineRetentionDays());
        if (deleted != null && deleted > 0) {
            log.info("envelope_quarantine.retention deleted={} retention_days={}",
                    deleted, e2ee.quarantineRetentionDays());
        }
    }
}
