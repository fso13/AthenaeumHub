package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.support.IntegrationTestBase;

/** V21 schema: pre-auth table, encrypted secret, no password, cleanup indexes, grants. */
@ActiveProfiles("test")
class AuthBffSchemaIT extends IntegrationTestBase {

    @Autowired
    private EmailVerificationRepository emailVerifications;

    @Test
    void createsEmailVerificationTableWithoutPasswordAndWithCleanupIndexes() {
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'auth' AND table_name = 'email_verifications'
                """, Integer.class)).isEqualTo(11);

        List<String> columns = jdbc.queryForList("""
                SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'auth' AND table_name = 'email_verifications'
                """, String.class);
        assertThat(columns).containsExactlyInAnyOrder(
                "id", "email", "display_name", "keycloak_user_id", "secret", "expires_at",
                "attempts", "consumed_at", "last_sent_at", "created_at",
                // #100: SHA-256 digest of an optional registration invite token.
                "invite_token_hash");
        assertThat(columns).noneMatch(column -> column.toLowerCase().contains("password"));

        assertThat(jdbc.queryForObject("""
                SELECT data_type FROM information_schema.columns
                 WHERE table_schema = 'auth' AND table_name = 'email_verifications'
                   AND column_name = 'secret'
                """, String.class)).isEqualTo("bytea");

        List<String> indexes = jdbc.queryForList("""
                SELECT indexname FROM pg_indexes
                 WHERE schemaname = 'auth' AND tablename = 'email_verifications'
                """, String.class);
        assertThat(indexes).contains(
                "ix_email_verifications_email_created",
                "ix_email_verifications_expiry",
                "ix_email_verifications_consumed");
    }

    @Test
    void repositoryCleanupQueriesUseTheRealPostgresSchema() {
        // Other auth test contexts use a different email-code key; their expired rows are
        // undecryptable here. Remove them so the global cleanup query only sees our rows.
        migrator().update("""
                DELETE FROM auth.email_verifications
                 WHERE consumed_at IS NULL AND expires_at < now()
                """);
        Instant now = Instant.now();
        EmailVerification expired = EmailVerification.create(UUID.randomUUID(),
                "cleanup-expired@krug.test", "Cleanup", UUID.randomUUID(),
                "01234567890123456789012345678901",
                now.plus(Duration.ofMinutes(10)), now);
        emailVerifications.save(expired);
        migrator().update("""
                UPDATE auth.email_verifications
                   SET created_at = now() - interval '11 minutes',
                       expires_at = now() - interval '1 second'
                 WHERE id = ?
                """, expired.id());
        assertThat(emailVerifications.findExpiredUnconsumed(now, 10))
                .extracting(EmailVerification::id).contains(expired.id());
        emailVerifications.delete(expired.id());

        EmailVerification consumed = EmailVerification.create(UUID.randomUUID(),
                "cleanup-consumed@krug.test", "Cleanup", UUID.randomUUID(),
                "01234567890123456789012345678901",
                now.plus(Duration.ofMinutes(10)), now);
        emailVerifications.save(consumed);
        migrator().update("""
                UPDATE auth.email_verifications
                   SET consumed_at = now() - interval '2 days'
                 WHERE id = ?
                """, consumed.id());
        assertThat(emailVerifications.deleteConsumedBefore(
                now.minus(Duration.ofDays(1)), 10)).isGreaterThanOrEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.email_verifications WHERE id = ?",
                Integer.class, consumed.id())).isZero();
    }

    @Test
    void runtimeRoleCanUseTheTableButItIsNotTenantRlsScoped() {
        assertThat(jdbc.queryForObject("""
                SELECT has_table_privilege('krug_app', 'auth.email_verifications', 'SELECT')
                   AND has_table_privilege('krug_app', 'auth.email_verifications', 'INSERT')
                   AND has_table_privilege('krug_app', 'auth.email_verifications', 'UPDATE')
                   AND has_table_privilege('krug_app', 'auth.email_verifications', 'DELETE')
                """, Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("""
                SELECT relrowsecurity FROM pg_class
                 WHERE oid = 'auth.email_verifications'::regclass
                """, Boolean.class)).isFalse();
    }
}
