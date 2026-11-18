package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * Applies V1–V15 on a real PostgreSQL 16 database, seeds pre-E7 data (normal, degraded and
 * deleted DIRECT, GROUP), then applies V16+ and asserts the backfill/invariants. Separate
 * databases prove the fail-fast preflight codes for corrupt DIRECT and duplicate pairs.
 *
 * <p>This is the B1 migration gate: Flyway runs the real files, not a copy.
 */
@ActiveProfiles("test")
class E2eeMigrationIT extends IntegrationTestBase {

    @Test
    void v16BackfillsDirectKeysAndCreatesE2eeStorage() {
        String db = databaseName("ok");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");

            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            UUID u3 = UUID.randomUUID();
            UUID u4 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, u3, u4);

            UUID normal = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            UUID degraded = seedDirect(jdbc, workspace, u1, u3, "ACTIVE", "REMOVED", null);
            UUID deleted = seedDirect(jdbc, workspace, u1, u4, "ACTIVE", "REMOVED", Instant.now());
            UUID group = seedGroup(jdbc, workspace, u1, u2);

            migrate(db, "16");

            assertThat(jdbc.queryForObject(
                    "SELECT direct_key FROM chat.chats WHERE id = ?", String.class, normal))
                    .isEqualTo(DirectPairKey.of(u1, u2));
            assertThat(jdbc.queryForObject(
                    "SELECT direct_key FROM chat.chats WHERE id = ?", String.class, degraded))
                    .isEqualTo(DirectPairKey.of(u1, u3));
            assertThat(jdbc.queryForObject(
                    "SELECT direct_key FROM chat.chats WHERE id = ?", String.class, deleted))
                    .isEqualTo(DirectPairKey.of(u1, u4));
            assertThat(jdbc.queryForObject(
                    "SELECT direct_key FROM chat.chats WHERE id = ?", String.class, group))
                    .isNull();

            // NOT VALID -> VALIDATE: both checks are validated, and the pair index exists.
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_constraint
                     WHERE conrelid = 'chat.chats'::regclass
                       AND conname IN ('ck_chats_direct_key', 'ck_chats_direct_key_format')
                       AND convalidated
                    """, Integer.class)).isEqualTo(2);
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_indexes
                     WHERE schemaname = 'chat' AND indexname = 'ux_chats_direct_pair'
                    """, Integer.class)).isEqualTo(1);

            // New storage, partitions, RLS and grants.
            for (String table : List.of("auth.device_prekeys", "auth.key_verifications",
                    "message.message_envelopes")) {
                assertThat(jdbc.queryForObject("""
                        SELECT count(*) FROM pg_tables
                         WHERE schemaname || '.' || tablename = ?
                        """, Integer.class, table)).isEqualTo(1);
            }
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_tables
                     WHERE schemaname = 'message'
                       AND tablename LIKE 'message_envelopes\\_2%'
                    """, Integer.class)).isGreaterThanOrEqualTo(3);
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_indexes
                     WHERE schemaname = 'message'
                       AND tablename LIKE 'message_envelopes\\_2%'
                    """, Integer.class)).isEqualTo(12);

            assertThat(jdbc.queryForObject("""
                    SELECT relrowsecurity FROM pg_class
                     WHERE oid = 'auth.device_prekeys'::regclass
                    """, Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class
                     WHERE oid = 'auth.device_prekeys'::regclass
                    """, Boolean.class)).isFalse();
            for (String table : List.of("auth.key_verifications",
                    "message.message_envelopes")) {
                assertThat(jdbc.queryForObject("""
                        SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
                         WHERE oid = ?::regclass
                        """, Boolean.class, table)).as(table).isTrue();
            }
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', 'auth.device_prekeys', 'SELECT')",
                    Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject(
                    "SELECT has_table_privilege('krug_app', 'auth.key_verifications', 'INSERT')",
                    Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject("""
                    SELECT has_table_privilege('krug_app',
                           'message.message_envelopes', 'INSERT')
                    """, Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'auth' AND p.proname = 'claim_one_time_prekey'
                    """, Integer.class)).isEqualTo(1);

            // A newly ensured month gets both partitions; envelopes carry exactly 4 indexes.
            jdbc.execute("SELECT message.ensure_partition(date_trunc('month', now() + interval '3 months')::date)");
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_indexes
                     WHERE schemaname = 'message'
                       AND tablename = 'message_envelopes_'
                           || to_char(date_trunc('month', now() + interval '3 months'), 'YYYY_MM')
                    """, Integer.class)).isEqualTo(4);

            // security_mode is immutable at the DB level.
            assertThatThrownBy(() -> jdbc.update(
                    "UPDATE chat.chats SET security_mode = 'E2EE' WHERE id = ?", normal))
                    .hasMessageContaining("MODE_CHANGE_FORBIDDEN");

            // E2EE message invariants: top-level reply_to_id is forbidden.
            assertThatThrownBy(() -> jdbc.update("""
                    INSERT INTO message.messages
                           (id, workspace_id, chat_id, seq, sender_id, sender_device_id, type,
                            crypto_scheme, body_ciphertext, content_meta, reply_to_id)
                    VALUES (?, ?, ?, 1, ?, ?, 'TEXT', 'E2EE_PAIRWISE', NULL, '{}'::jsonb, ?)
                    """, UUID.randomUUID(), workspace, normal, u1, UUID.randomUUID(),
                    UUID.randomUUID()))
                    .hasMessageContaining("ck_messages_e2ee_no_reply_to_id");

            // The envelopes PK is (message_id, recipient_device_id, created_at); the parent
            // indexes are inherited automatically.
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_indexes
                     WHERE schemaname = 'message'
                       AND tablename = 'message_envelopes'
                       AND indexname LIKE 'ix_envelopes_%'
                    """, Integer.class)).isEqualTo(3);
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void corruptDirectFailsFastWithDiagnosticCode() {
        String db = databaseName("corrupt");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, UUID.randomUUID(), UUID.randomUUID(),
                    UUID.randomUUID());
            UUID chat = UUID.randomUUID();
            jdbc.update("""
                    INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                    VALUES (?, ?, 'DIRECT', 'MANAGED', 'broken', ?)
                    """, chat, workspace, u1);
            jdbc.update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                    """, chat, workspace, u1);

            assertThatThrownBy(() -> migrate(db, "16"))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("DIRECT_KEY_UNRESOLVED")
                            .contains(chat.toString()));
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void duplicateLiveDirectPairFailsFastWithRunbookCode() {
        String db = databaseName("duplicate");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);

            assertThatThrownBy(() -> migrate(db, "16"))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("DIRECT_PAIR_DUPLICATE"));
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void v17MakesIdentityUniquenessHardAndAllOrNoneNullSafe() {
        String db = databaseName("v17");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            UUID u3 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, u3, UUID.randomUUID());
            UUID legacy = insertLegacyDeviceAtV15(jdbc, u1);

            migrate(db, "16");

            // V16's partial indexes let a REVOKED pair be duplicated (P1-06). The buggy
            // CHECK lets an "impossible" half-keyed row through (P2-01).
            byte[] sig = bytes(0x11, 32);
            byte[] dh = bytes(0x22, 32);
            byte[] binding = bytes(0x33, 64);
            byte[] fp = bytes(0x44, 32);
            UUID revokedFirst = insertKeyedDevice(jdbc, u1, "REVOKED", sig, dh, binding, fp,
                    "2025-01-01T00:00:00Z");
            UUID revokedSecond = insertKeyedDevice(jdbc, u2, "REVOKED", sig, dh, binding, fp,
                    "2025-06-01T00:00:00Z");
            UUID incomplete = insertHalfKeyedDevice(jdbc, u2, sig);

            migrate(db, "17");

            // Exactly one row keeps the pair; the loser is quarantined, not deleted.
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM auth.devices WHERE identity_signing_key = decode(?,'hex')
                    """, Integer.class, hex(sig))).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                    SELECT status FROM auth.devices WHERE identity_signing_key = decode(?,'hex')
                    """, String.class, hex(sig))).isEqualTo("REVOKED");
            assertThat(jdbc.queryForObject("""
                    SELECT identity_key_alg FROM auth.devices WHERE id = ?
                    """, String.class, revokedSecond)).isEqualTo("LEGACY");
            assertThat(jdbc.queryForObject(
                    "SELECT count(*) FROM auth.identity_key_quarantine",
                    Integer.class)).isEqualTo(2);
            assertThat(jdbc.queryForObject("""
                    SELECT string_agg(reason, ',') FROM auth.identity_key_quarantine
                    """, String.class)).contains("DUPLICATE_IDENTITY_KEY")
                    .contains("INCOMPLETE_IDENTITY_KEYS");
            assertThat(jdbc.queryForObject("""
                    SELECT identity_key_alg FROM auth.devices WHERE id = ?
                    """, String.class, incomplete)).isEqualTo("LEGACY");

            // Legacy backfill from V16 still applied (P1-05 path).
            assertThat(jdbc.queryForObject(
                    "SELECT identity_key_alg FROM auth.devices WHERE id = ?", String.class,
                    legacy)).isEqualTo("LEGACY");

            // Hard global uniqueness: a NEW account can no longer resurrect the revoked pair.
            assertThatThrownBy(() -> insertKeyedDevice(jdbc, u3, "ACTIVE", sig, dh, binding, fp,
                    "2026-01-01T00:00:00Z"))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("ux_devices_identity"));

            // NULL-safe all-or-none: a half-keyed row is rejected (V16 accepted it).
            assertThatThrownBy(() -> insertHalfKeyedDevice(jdbc, u3, sig))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("ck_devices_keys_all_or_none"));

            // One capability predicate, matching Device.isE2eeCapable().
            UUID active = insertKeyedDevice(jdbc, u3, "ACTIVE", bytes(0x55, 32),
                    bytes(0x66, 32), bytes(0x77, 64), bytes(0x88, 32),
                    "2026-02-01T00:00:00Z");
            assertThat(jdbc.queryForObject("""
                    SELECT auth.device_is_e2ee_capable(status, identity_key_alg,
                            identity_signing_key, identity_dh_key, identity_binding_signature,
                            fingerprint)
                      FROM auth.devices WHERE id = ?
                    """, Boolean.class, active)).isTrue();
            assertThat(jdbc.queryForObject("""
                    SELECT auth.device_is_e2ee_capable(status, identity_key_alg,
                            identity_signing_key, identity_dh_key, identity_binding_signature,
                            fingerprint)
                      FROM auth.devices WHERE id = ?
                    """, Boolean.class, revokedFirst)).isFalse();
            // Legacy rows are never capable, matching Device.isE2eeCapable().
            assertThat(jdbc.queryForObject("""
                    SELECT auth.device_is_e2ee_capable(status, identity_key_alg,
                            identity_signing_key, identity_dh_key, identity_binding_signature,
                            fingerprint)
                      FROM auth.devices WHERE id = ?
                    """, Boolean.class, legacy)).isFalse();

            // Index predicate is truly global and FORCE RLS is restored after the repair.
            assertThat(jdbc.queryForObject("""
                    SELECT indexdef FROM pg_indexes
                     WHERE schemaname = 'auth' AND indexname = 'ux_devices_identity_sig'
                    """, String.class)).doesNotContain("REVOKED");
            for (String table : List.of("auth.devices", "chat.chats", "chat.chat_members")) {
                assertThat(jdbc.queryForObject("""
                        SELECT relforcerowsecurity FROM pg_class WHERE oid = ?::regclass
                        """, Boolean.class, table)).as(table).isTrue();
            }
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void v17VerificationTriggerRequiresActiveCapableTargetAndActiveVerifier() {
        String db = databaseName("v17trg");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            UUID chat = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            migrate(db, "17");

            UUID activeTarget = insertKeyedDevice(jdbc, u2, "ACTIVE", bytes(0x01, 32),
                    bytes(0x02, 32), bytes(0x03, 64), bytes(0x04, 32),
                    "2026-01-01T00:00:00Z");
            UUID revokedTarget = insertKeyedDevice(jdbc, u2, "REVOKED", bytes(0x05, 32),
                    bytes(0x06, 32), bytes(0x07, 64), bytes(0x08, 32),
                    "2026-01-01T00:00:00Z");
            UUID activeVerifier = insertKeyedDevice(jdbc, u1, "ACTIVE", bytes(0x09, 32),
                    bytes(0x0a, 32), bytes(0x0b, 64), bytes(0x0c, 32),
                    "2026-01-01T00:00:00Z");
            UUID revokedVerifier = insertKeyedDevice(jdbc, u1, "REVOKED", bytes(0x0d, 32),
                    bytes(0x0e, 32), bytes(0x0f, 64), bytes(0x10, 32),
                    "2026-01-01T00:00:00Z");

            // Target must be ACTIVE + capable.
            assertThatThrownBy(() -> insertVerification(jdbc, workspace, chat, u1,
                    activeVerifier, revokedTarget))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("VERIFICATION_SCOPE_MISMATCH"));
            // Verifier DEVICE must be ACTIVE (a LEGACY but ACTIVE verifier is allowed).
            assertThatThrownBy(() -> insertVerification(jdbc, workspace, chat, u1,
                    revokedVerifier, activeTarget))
                    .satisfies(ex -> assertThat(rootMessage(ex))
                            .contains("VERIFICATION_SCOPE_MISMATCH"));
            insertVerification(jdbc, workspace, chat, u1, activeVerifier, activeTarget);
            assertThat(jdbc.queryForObject(
                    "SELECT count(*) FROM auth.key_verifications", Integer.class)).isEqualTo(1);
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void v19QuarantinesLegacyEnvelopesAndValidatesTheCiphertextFloor() {
        String db = databaseName("v19");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            UUID chat = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            UUID sender = UUID.randomUUID();
            UUID recipient = UUID.randomUUID();
            migrate(db, "17");

            // The rows a pre-B3F database can contain after V17: 16 B and 271 B legacy
            // envelopes plus one canonical 272 B row. V18 must accept the migration
            // (NOT VALID) and V19 must quarantine exactly the two short rows.
            UUID legacy16 = UUID.randomUUID();
            UUID legacy271 = UUID.randomUUID();
            UUID valid = UUID.randomUUID();
            insertEnvelopeAtV17(jdbc, legacy16, recipient, sender, workspace, chat, 16,
                    0x16);
            insertEnvelopeAtV17(jdbc, legacy271, recipient, sender, workspace, chat, 271,
                    0x27);
            insertEnvelopeAtV17(jdbc, valid, recipient, sender, workspace, chat, 272, 0x28);

            // Snapshot the complete live rows before V19; the quarantine copy must be
            // byte-for-byte identical, not merely the same size/reason.
            Map<String, Object> legacy16Row = envelopeRow(jdbc, legacy16);
            Map<String, Object> legacy271Row = envelopeRow(jdbc, legacy271);

            migrate(db, "18");
            assertThat(floorConstraintCount(jdbc)).isGreaterThanOrEqualTo(4);
            assertThat(unvalidatedFloorConstraints(jdbc)).isGreaterThanOrEqualTo(4);
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes
                     WHERE octet_length(ciphertext) < 272
                    """, Integer.class)).isEqualTo(2);

            migrate(db, "19");

            assertThat(unvalidatedFloorConstraints(jdbc)).isZero();
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes
                     WHERE octet_length(ciphertext) < 272
                    """, Integer.class)).isZero();
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes
                     WHERE message_id IN (?, ?)
                    """, Integer.class, legacy16, legacy271)).isZero();
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes_quarantine
                     WHERE reason = 'legacy_short'
                    """, Integer.class)).isEqualTo(2);
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes_quarantine
                     WHERE message_id = ? AND octet_length(ciphertext) = 16
                    """, Integer.class, legacy16)).isEqualTo(1);
            // Byte-level lossless assertion: every copied column (including session_id,
            // header and ciphertext) equals the snapshot taken before the DELETE.
            assertQuarantineRowMatches(jdbc, legacy16Row, "legacy_short");
            assertQuarantineRowMatches(jdbc, legacy271Row, "legacy_short");
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes
                     WHERE message_id = ? AND octet_length(ciphertext) = 272
                    """, Integer.class, valid)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class
                     WHERE oid = 'message.message_envelopes'::regclass
                    """, Boolean.class)).isTrue();
            // The quarantine is for audit/forensics only: runtime role has no access.
            assertThat(jdbc.queryForObject("""
                    SELECT has_table_privilege('krug_app',
                           'message.message_envelopes_quarantine', 'SELECT')
                    """, Boolean.class)).isFalse();
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void v19DeleteOnlyRemovesRowsActuallyCopiedToQuarantine() {
        String db = databaseName("v19conflict");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            UUID chat = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            UUID sender = UUID.randomUUID();
            UUID recipient = UUID.randomUUID();
            migrate(db, "17");
            UUID legacy = UUID.randomUUID();
            insertEnvelopeAtV17(jdbc, legacy, recipient, sender, workspace, chat, 16, 0x31);
            migrate(db, "18");

            // Pre-create the V19 quarantine table and seed a conflicting copy with the
            // same primary key but different bytes. V19's INSERT..ON CONFLICT skips it;
            // the strengthened DELETE must therefore leave the live row in place and let
            // VALIDATE fail fast instead of silently destroying un-copied data.
            jdbc.execute("""
                    CREATE TABLE message.message_envelopes_quarantine (
                      message_id uuid NOT NULL,
                      recipient_device_id uuid NOT NULL,
                      sender_device_id uuid NOT NULL,
                      workspace_id uuid NOT NULL,
                      chat_id uuid NOT NULL,
                      scheme text NOT NULL,
                      sender_key_generation integer NOT NULL,
                      recipient_key_generation integer NOT NULL,
                      session_id bytea NOT NULL,
                      header jsonb NOT NULL,
                      ciphertext bytea NOT NULL,
                      prekey jsonb,
                      created_at timestamptz NOT NULL,
                      reason text NOT NULL,
                      quarantined_at timestamptz NOT NULL DEFAULT now(),
                      PRIMARY KEY (message_id, recipient_device_id, created_at)
                    )
                    """);
            jdbc.update("""
                    INSERT INTO message.message_envelopes_quarantine
                           (message_id, recipient_device_id, sender_device_id, workspace_id,
                            chat_id, scheme, sender_key_generation, recipient_key_generation,
                            session_id, header, ciphertext, prekey, created_at, reason)
                    SELECT message_id, recipient_device_id, sender_device_id, workspace_id,
                           chat_id, scheme, sender_key_generation, recipient_key_generation,
                           session_id, header, decode(repeat('ee', 272), 'hex'), prekey,
                           created_at, 'audit-conflict'
                      FROM message.message_envelopes WHERE message_id = ?
                    """, legacy);

            assertThatThrownBy(() -> migrate(db, "19"))
                    .hasStackTraceContaining("ck_envelopes_ciphertext_min");

            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes WHERE message_id = ?
                    """, Integer.class, legacy)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                    SELECT reason FROM message.message_envelopes_quarantine
                     WHERE message_id = ?
                    """, String.class, legacy)).isEqualTo("audit-conflict");
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class
                     WHERE oid = 'message.message_envelopes'::regclass
                    """, Boolean.class)).isTrue();
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void v20EnablesOwnerOnlyRlsAndBoundedQuarantineRetention() {
        String db = databaseName("v20");
        createDatabase(db);
        try {
            JdbcTemplate jdbc = dbJdbc(db);
            migrate(db, "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            UUID chat = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            UUID sender = UUID.randomUUID();
            UUID recipient = UUID.randomUUID();
            migrate(db, "17");
            insertEnvelopeAtV17(jdbc, UUID.randomUUID(), recipient, sender, workspace, chat,
                    16, 0x41);
            migrate(db, "18");
            migrate(db, "19");
            migrate(db, "20");

            // RLS without FORCE: the schema owner can run retention, while a future broad
            // GRANT or DB_USER==FLYWAY_USER still cannot read the quarantine.
            assertThat(jdbc.queryForObject("""
                    SELECT relrowsecurity FROM pg_class
                     WHERE oid = 'message.message_envelopes_quarantine'::regclass
                    """, Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class
                     WHERE oid = 'message.message_envelopes_quarantine'::regclass
                    """, Boolean.class)).isFalse();
            for (String privilege : List.of("SELECT", "INSERT", "UPDATE", "DELETE")) {
                assertThat(jdbc.queryForObject("""
                        SELECT has_table_privilege('krug_app',
                               'message.message_envelopes_quarantine', ?)
                        """, Boolean.class, privilege)).as(privilege).isFalse();
            }
            assertThat(jdbc.queryForObject("""
                    SELECT prosecdef FROM pg_proc p JOIN pg_namespace n
                           ON n.oid = p.pronamespace
                     WHERE n.nspname = 'message'
                       AND p.proname = 'purge_envelope_quarantine'
                    """, Boolean.class)).isTrue();

            // Retention is owner-executed through a SECURITY DEFINER function; krug_app may
            // execute it but has no table access at all.
            UUID old = UUID.randomUUID();
            UUID fresh = UUID.randomUUID();
            insertQuarantineAt(jdbc, old, recipient, sender, workspace, chat,
                    Instant.now().minus(100, java.time.temporal.ChronoUnit.DAYS));
            insertQuarantineAt(jdbc, fresh, recipient, sender, workspace, chat, Instant.now());

            JdbcTemplate app = appJdbc(db);
            assertThatThrownBy(() -> app.queryForObject(
                    "SELECT count(*) FROM message.message_envelopes_quarantine",
                    Integer.class)).hasStackTraceContaining("permission denied");
            assertThat(app.queryForObject(
                    "SELECT message.purge_envelope_quarantine(90)", Integer.class))
                    .isEqualTo(1);
            assertThat(quarantineCountFor(jdbc, old)).isZero();
            assertThat(quarantineCountFor(jdbc, fresh)).isEqualTo(1);
            // The V19 row from the migration itself is recent and must survive.
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes_quarantine
                    """, Integer.class)).isEqualTo(2);
            assertThatThrownBy(() -> app.queryForObject(
                    "SELECT message.purge_envelope_quarantine(0)", Integer.class))
                    .hasStackTraceContaining("QUARANTINE_RETENTION_INVALID");
        } finally {
            dropDatabase(db);
        }
    }

    @Test
    void nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17() {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String role = "mig_owner_" + suffix;
        String db = "krug_owner_" + suffix;
        migrator().execute("CREATE ROLE \"" + role + "\" LOGIN PASSWORD 'owner-pw' "
                + "NOSUPERUSER NOBYPASSRLS CREATEROLE");
        migrator().execute("CREATE DATABASE \"" + db + "\" OWNER \"" + role + "\"");
        try {
            // Seed and assert as the container superuser: FORCE RLS applies to the owner
            // too, so only Flyway itself must run as the non-superuser owner.
            JdbcTemplate jdbc = dbJdbc(db);
            migrateAs(db, role, "owner-pw", "15");
            UUID workspace = UUID.randomUUID();
            UUID u1 = UUID.randomUUID();
            UUID u2 = UUID.randomUUID();
            seedWorkspace(jdbc, workspace, u1, u2, UUID.randomUUID(), UUID.randomUUID());
            UUID chat = seedDirect(jdbc, workspace, u1, u2, "ACTIVE", "ACTIVE", null);
            UUID device = insertLegacyDeviceAtV15(jdbc, u1);

            // The owner is NOT superuser and has no BYPASSRLS: without the V16 NO FORCE
            // backfill window both backfills would be silent no-ops (P1-05).
            migrateAs(db, role, "owner-pw", "16");
            assertThat(jdbc.queryForObject(
                    "SELECT identity_key_alg FROM auth.devices WHERE id = ?", String.class,
                    device)).isEqualTo("LEGACY");
            assertThat(jdbc.queryForObject(
                    "SELECT direct_key FROM chat.chats WHERE id = ?", String.class, chat))
                    .isNotNull();
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class WHERE oid = 'auth.devices'::regclass
                    """, Boolean.class)).isTrue();

            migrateAs(db, role, "owner-pw", "17");
            assertThat(jdbc.queryForObject("""
                    SELECT indexdef FROM pg_indexes
                     WHERE schemaname = 'auth' AND indexname = 'ux_devices_identity_sig'
                    """, String.class)).doesNotContain("REVOKED");
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'auth' AND p.proname = 'device_is_e2ee_capable'
                    """, Integer.class)).isEqualTo(1);

            // P1-03: the same non-superuser owner must be able to run V18 and V19 over a
            // legacy row. V19's temporary NO FORCE window is what lets it see/delete the
            // row without superuser/BYPASSRLS.
            UUID legacyMessage = UUID.randomUUID();
            insertEnvelopeAtV17(jdbc, legacyMessage, UUID.randomUUID(), UUID.randomUUID(),
                    workspace, chat, 16, 0x19);
            insertEnvelopeAtV17(jdbc, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                    workspace, chat, 272, 0x20);
            migrateAs(db, role, "owner-pw", "18");
            assertThat(unvalidatedFloorConstraints(jdbc)).isGreaterThanOrEqualTo(1);
            migrateAs(db, role, "owner-pw", "19");
            assertThat(unvalidatedFloorConstraints(jdbc)).isZero();
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes_quarantine
                     WHERE message_id = ? AND reason = 'legacy_short'
                    """, Integer.class, legacyMessage)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM message.message_envelopes WHERE message_id = ?
                    """, Integer.class, legacyMessage)).isZero();
            assertThat(jdbc.queryForObject("""
                    SELECT relforcerowsecurity FROM pg_class
                     WHERE oid = 'message.message_envelopes'::regclass
                    """, Boolean.class)).isTrue();
        } finally {
            dropDatabase(db);
            try {
                migrator().execute("DROP ROLE IF EXISTS \"" + role + "\"");
            } catch (RuntimeException ignored) {
                // the role may still own objects in a failed run; cluster is discarded
            }
        }
    }

    // ---------------------------------------------------------------------

    private void insertEnvelopeAtV17(JdbcTemplate jdbc, UUID messageId, UUID recipient,
                                     UUID sender, UUID workspace, UUID chat,
                                     int ciphertextBytes, int fill) {
        String header = "{\"v\":1,\"dh\":\"" + "A".repeat(43)
                + "\",\"pn\":0,\"n\":0}";
        jdbc.update("""
                INSERT INTO message.message_envelopes
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, prekey, created_at)
                VALUES (?, ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                        decode(repeat('00', 16), 'hex'), CAST(? AS jsonb), decode(?, 'hex'),
                        NULL, now())
                """, messageId, recipient, sender, workspace, chat, header,
                hex(bytes(fill, ciphertextBytes)));
    }

    /** Full live row snapshot used to prove the quarantine copy is byte-for-byte lossless. */
    private Map<String, Object> envelopeRow(JdbcTemplate jdbc, UUID messageId) {
        return jdbc.queryForMap("""
                SELECT message_id, recipient_device_id, sender_device_id, workspace_id,
                       chat_id, scheme, sender_key_generation, recipient_key_generation,
                       session_id, header::text AS header, ciphertext,
                       prekey::text AS prekey, created_at
                  FROM message.message_envelopes WHERE message_id = ?
                """, messageId);
    }

    private void assertQuarantineRowMatches(JdbcTemplate jdbc, Map<String, Object> expected,
                                            String reason) {
        Map<String, Object> actual = jdbc.queryForMap("""
                SELECT message_id, recipient_device_id, sender_device_id, workspace_id,
                       chat_id, scheme, sender_key_generation, recipient_key_generation,
                       session_id, header::text AS header, ciphertext,
                       prekey::text AS prekey, created_at, reason
                  FROM message.message_envelopes_quarantine
                 WHERE message_id = ?
                """, expected.get("message_id"));
        assertThat(actual.get("reason")).isEqualTo(reason);
        for (String column : expected.keySet()) {
            assertThat(actual.get(column)).as(column).isEqualTo(expected.get(column));
        }
    }

    private void insertQuarantineAt(JdbcTemplate jdbc, UUID messageId, UUID recipient,
                                    UUID sender, UUID workspace, UUID chat, Instant at) {
        jdbc.update("""
                INSERT INTO message.message_envelopes_quarantine
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, prekey, created_at, reason,
                        quarantined_at)
                VALUES (?, ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                        decode(repeat('00', 16), 'hex'), '{}'::jsonb,
                        decode(repeat('00', 272), 'hex'), NULL, now(), 'legacy_short', ?)
                """, messageId, recipient, sender, workspace, chat, Timestamp.from(at));
    }

    private int quarantineCountFor(JdbcTemplate jdbc, UUID messageId) {
        Integer count = jdbc.queryForObject("""
                SELECT count(*) FROM message.message_envelopes_quarantine
                 WHERE message_id = ?
                """, Integer.class, messageId);
        return count == null ? 0 : count;
    }

    private JdbcTemplate appJdbc(String database) {
        return new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl().replace("/krug", "/" + database), "krug_app",
                "krug_app"));
    }

    private int floorConstraintCount(JdbcTemplate jdbc) {
        Integer count = jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conname = 'ck_envelopes_ciphertext_min'
                """, Integer.class);
        return count == null ? 0 : count;
    }

    private int unvalidatedFloorConstraints(JdbcTemplate jdbc) {
        Integer count = jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conname = 'ck_envelopes_ciphertext_min' AND NOT convalidated
                """, Integer.class);
        return count == null ? 0 : count;
    }

    private void migrateAs(String database, String user, String password, String target) {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl().replace("/krug", "/" + database), user,
                        password)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(target))
                .load()
                .migrate();
    }

    /** Pre-V16 row: identity_key_alg still has the V2 default 'Ed25519'. */
    private UUID insertLegacyDeviceAtV15(JdbcTemplate jdbc, UUID userId) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO auth.devices (id, user_id, name, platform, app_version)
                VALUES (?, ?, 'legacy', 'WEB', '0.7.0')
                """, id, userId);
        return id;
    }

    /** Post-V16/V17 row: the V16 migration dropped the identity_key_alg default. */
    private UUID insertLegacyDevice(JdbcTemplate jdbc, UUID userId) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO auth.devices
                       (id, user_id, name, platform, app_version, identity_key_alg)
                VALUES (?, ?, 'legacy', 'WEB', '0.7.0', 'LEGACY')
                """, id, userId);
        return id;
    }

    private UUID insertKeyedDevice(JdbcTemplate jdbc, UUID userId, String status, byte[] sig,
                                   byte[] dh, byte[] binding, byte[] fingerprint,
                                   String createdAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO auth.devices
                       (id, user_id, name, platform, app_version, identity_key_alg,
                        identity_signing_key, identity_dh_key, identity_binding_signature,
                        fingerprint, status, revoked_at, created_at)
                VALUES (?, ?, 'keyed', 'WEB', '0.7.0', 'Ed25519+X25519',
                        decode(?,'hex'), decode(?,'hex'), decode(?,'hex'), decode(?,'hex'),
                        ?, CASE WHEN ? = 'REVOKED' THEN now() END, ?::timestamptz)
                """, id, userId, hex(sig), hex(dh), hex(binding), hex(fingerprint), status,
                status, createdAt);
        return id;
    }

    /** Mirrors the row V16's NULL-unsafe CHECK accepted (P2-01). */
    private UUID insertHalfKeyedDevice(JdbcTemplate jdbc, UUID userId, byte[] sig) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO auth.devices
                       (id, user_id, name, platform, app_version, identity_key_alg,
                        identity_signing_key, identity_dh_key, identity_binding_signature,
                        fingerprint)
                VALUES (?, ?, 'half', 'WEB', '0.7.0', 'Ed25519+X25519', decode(?,'hex'),
                        NULL, NULL, NULL)
                """, id, userId, hex(sig));
        return id;
    }

    private void insertVerification(JdbcTemplate jdbc, UUID workspace, UUID chat, UUID user,
                                    UUID verifierDevice, UUID targetDevice) {
        jdbc.update("""
                INSERT INTO auth.key_verifications
                       (id, workspace_id, chat_id, verifier_user_id, verifier_device_id,
                        target_device_id, target_key_generation, method, vh_version,
                        safety_number_hash)
                VALUES (?, ?, ?, ?, ?, ?, 1, 'MANUAL', 2, decode(repeat('00', 32), 'hex'))
                """, UUID.randomUUID(), workspace, chat, user, verifierDevice, targetDevice);
    }

    private static byte[] bytes(int fill, int length) {
        byte[] value = new byte[length];
        java.util.Arrays.fill(value, (byte) fill);
        return value;
    }

    private static String hex(byte[] value) {
        return java.util.HexFormat.of().formatHex(value);
    }

    private static String databaseName(String suffix) {
        return "krug_v16_" + suffix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private JdbcTemplate dbJdbc(String database) {
        return new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl().replace("/krug", "/" + database),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    private void createDatabase(String name) {
        migrator().execute("CREATE DATABASE \"" + name + "\"");
    }

    private void dropDatabase(String name) {
        try {
            migrator().query("""
                    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                     WHERE datname = ? AND pid <> pg_backend_pid()
                    """, rs -> { }, name);
            migrator().execute("DROP DATABASE IF EXISTS \"" + name + "\" WITH (FORCE)");
        } catch (RuntimeException ignored) {
            // best-effort cleanup; the shared container is discarded after the JVM exits
        }
    }

    private void migrate(String database, String target) {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl().replace("/krug", "/" + database),
                        POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(target))
                .load()
                .migrate();
    }

    private void seedWorkspace(JdbcTemplate jdbc, UUID workspace, UUID... users) {
        for (UUID user : users) {
            jdbc.update("""
                    INSERT INTO auth.users (id, email, display_name) VALUES (?, ?, ?)
                    ON CONFLICT (id) DO NOTHING
                    """, user, user + "@example.test", "user");
        }
        jdbc.update("""
                INSERT INTO workspace.workspaces (id, name, slug, security_mode, created_by)
                VALUES (?, 'Migration', ?, 'MANAGED', ?)
                """, workspace, "migration-" + workspace, users[0]);
        for (UUID user : users) {
            jdbc.update("""
                    INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, 'ACTIVE')
                    ON CONFLICT (workspace_id, user_id) DO NOTHING
                    """, workspace, user, user.equals(users[0]) ? "OWNER" : "MEMBER");
        }
    }

    private UUID seedDirect(JdbcTemplate jdbc, UUID workspace, UUID first, UUID second,
                            String firstStatus, String secondStatus, Instant deletedAt) {
        UUID chat = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, deleted_at)
                VALUES (?, ?, 'DIRECT', 'MANAGED', NULL, ?, ?)
                """, chat, workspace, first, deletedAt == null ? null
                        : java.sql.Timestamp.from(deletedAt));
        jdbc.update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', ?)
                """, chat, workspace, first, firstStatus);
        jdbc.update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', ?)
                """, chat, workspace, second, secondStatus);
        jdbc.update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chat, workspace);
        return chat;
    }

    private UUID seedGroup(JdbcTemplate jdbc, UUID workspace, UUID first, UUID second) {
        UUID chat = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'MANAGED', 'group', ?)
                """, chat, workspace, first);
        for (UUID member : List.of(first, second)) {
            jdbc.update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                    """, chat, workspace, member, member.equals(first) ? "OWNER" : "MEMBER");
        }
        jdbc.update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chat, workspace);
        return chat;
    }

    private static String rootMessage(Throwable throwable) {
        Throwable current = throwable;
        StringBuilder messages = new StringBuilder();
        while (current != null) {
            if (current.getMessage() != null) {
                messages.append(current.getMessage()).append('\n');
            }
            current = current.getCause();
        }
        return messages.toString();
    }
}
