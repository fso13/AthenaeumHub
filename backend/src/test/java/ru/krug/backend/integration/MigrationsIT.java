package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class MigrationsIT extends IntegrationTestBase {

    @Test
    void appliesSchemaForAllBoundedContexts() {
        List<String> tables = jdbc.queryForList("""
                SELECT tablename FROM pg_tables
                 WHERE schemaname IN ('auth', 'workspace', 'chat', 'message', 'ops', 'sticker',
                                      'notification')
                """, String.class);
        assertThat(tables).contains(
                "users", "devices", "workspaces", "memberships", "chats", "chat_members",
                "chat_counters", "messages", "read_receipts", "idempotency_keys", "outbox",
                "sticker_packs", "stickers", "sticker_favorites",
                "notifications", "notification_preferences");
    }

    @Test
    void createsCurrentAndFutureMessagePartitions() {
        Integer partitions = jdbc.queryForObject("""
                SELECT count(*) FROM pg_class
                 WHERE relname LIKE 'messages\\_2%' AND relkind = 'r'
                """, Integer.class);
        assertThat(partitions).isGreaterThanOrEqualTo(3);

        List<String> indexes = jdbc.queryForList("""
                SELECT indexname FROM pg_indexes
                 WHERE schemaname = 'message' AND indexname LIKE '%\\_chat\\_seq'
                """, String.class);
        assertThat(indexes).isNotEmpty();

        List<String> clientIndexes = jdbc.queryForList("""
                SELECT indexname FROM pg_indexes
                 WHERE schemaname = 'message' AND indexname LIKE '%\\_client'
                """, String.class);
        assertThat(clientIndexes).isNotEmpty();
    }

    @Test
    void enablesAndForcesRowLevelSecurity() {
        Map<String, Object> messageFlags = jdbc.queryForMap("""
                SELECT relrowsecurity, relforcerowsecurity
                  FROM pg_class WHERE oid = 'message.messages'::regclass
                """);
        assertThat(messageFlags.get("relrowsecurity")).isEqualTo(true);
        assertThat(messageFlags.get("relforcerowsecurity")).isEqualTo(true);

        for (String table : List.of("chat.chats", "chat.chat_members", "chat.chat_counters",
                "chat.read_receipts", "workspace.workspaces", "workspace.memberships",
                "auth.users", "auth.devices", "ops.idempotency_keys", "ops.outbox",
                "sticker.sticker_favorites", "notification.notifications",
                "notification.notification_preferences")) {
            Map<String, Object> flags = jdbc.queryForMap("""
                    SELECT relrowsecurity, relforcerowsecurity
                      FROM pg_class WHERE oid = ?::regclass
                    """, table);
            assertThat(flags.get("relrowsecurity")).as(table).isEqualTo(true);
            assertThat(flags.get("relforcerowsecurity")).as(table).isEqualTo(true);
        }
    }

    @Test
    void seedsBuiltInStickerCatalogAndStickerMessageColumn() {
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM sticker.sticker_packs WHERE builtin
                """, Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM sticker.stickers
                """, Integer.class)).isEqualTo(16);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM sticker.stickers
                 WHERE format = 'PNG' AND width = 512 AND height = 512
                   AND size_bytes <= 524288
                """, Integer.class)).isEqualTo(16);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM sticker.sticker_packs
                 WHERE slug IN ('krug', 'cats') AND status = 'ACTIVE' AND builtin
                """, Integer.class)).isEqualTo(2);

        // Global built-in catalog is not RLS-scoped; favorites are.
        assertThat(jdbc.queryForObject("""
                SELECT relforcerowsecurity FROM pg_class
                 WHERE oid = 'sticker.sticker_packs'::regclass
                """, Boolean.class)).isFalse();
        assertThat(jdbc.queryForObject("""
                SELECT relforcerowsecurity FROM pg_class
                 WHERE oid = 'sticker.sticker_favorites'::regclass
                """, Boolean.class)).isTrue();

        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'messages'
                   AND column_name = 'sticker_id'
                """, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'message.messages'::regclass
                   AND conname IN ('ck_messages_type', 'ck_messages_sticker_present',
                                   'ck_messages_sticker_only', 'ck_messages_sticker_no_body')
                """, Integer.class)).isEqualTo(4);
    }

    @Test
    void createsNotificationSchemaIndexesAndDedupeConstraint() {
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'notification' AND table_name = 'notifications'
                   AND column_name IN ('id', 'user_id', 'workspace_id', 'chat_id', 'type',
                                       'title', 'body', 'dedupe_key', 'read_at', 'created_at')
                """, Integer.class)).isEqualTo(10);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'notification'
                   AND indexname IN ('ix_notifications_user_created',
                                     'ix_notifications_user_unread',
                                     'uq_notifications_dedupe',
                                     'ix_notification_preferences_user',
                                     'uq_notification_preferences_scope')
                """, Integer.class)).isEqualTo(5);
        // chat_id nullable must still be part of a strict upsert key.
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_index i
                  JOIN pg_class c ON c.oid = i.indexrelid
                 WHERE i.indrelid = 'notification.notification_preferences'::regclass
                   AND c.relname = 'uq_notification_preferences_scope'
                   AND i.indnullsnotdistinct
                """, Integer.class)).isEqualTo(1);
    }

    @Test
    void createsThreadColumnIndexConstraintAndTrigger() {
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'messages'
                   AND column_name = 'thread_root_id'
                """, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'message.messages'::regclass
                   AND conname IN ('ck_messages_thread_no_self',
                                   'ck_messages_e2ee_no_thread_root')
                """, Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_trigger
                 WHERE tgrelid = 'message.messages'::regclass
                   AND tgname = 'trg_messages_thread_root' AND NOT tgisinternal
                """, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
                SELECT indexdef FROM pg_indexes
                 WHERE schemaname = 'message' AND indexname = 'ix_messages_chat_thread_seq'
                """, String.class)).contains("(chat_id, thread_root_id, seq)");
        // The partitioned index is cloned onto every current partition.
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'message' AND tablename LIKE 'messages\\_2%'
                   AND indexdef LIKE '%(chat_id, thread_root_id, seq)%'
                """, Integer.class)).isGreaterThanOrEqualTo(3);
    }

    @Test
    void createsAppAndMigratorRolesAndPartitionFunction() {
        Integer roles = jdbc.queryForObject("""
                SELECT count(*) FROM pg_roles WHERE rolname IN ('krug_migrator', 'krug_app')
                """, Integer.class);
        assertThat(roles).isEqualTo(2);

        Integer functions = jdbc.queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'message' AND p.proname = 'ensure_partition'
                """, Integer.class);
        assertThat(functions).isEqualTo(1);
    }
}
