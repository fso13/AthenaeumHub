package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.support.IntegrationTestBase;

/**
 * E7-B1F P2-12: EXPLAIN coverage for the B1 hot paths. Each query must be index-backed on
 * a realistically sized table, not a sequential scan:
 * <ul>
 *   <li>claim: {@code auth.device_prekeys} partial index;</li>
 *   <li>device list: {@code (user_id, status)} index;</li>
 *   <li>identity lookup: the global unique identity indexes;</li>
 *   <li>envelopes for a recipient device: {@code ix_envelopes_recipient} (inherited by
 *       every partition).</li>
 * </ul>
 * The tables are seeded large enough that the planner would notice a missing index.
 */
@ActiveProfiles("test")
class E2eeQueryPlanIT extends IntegrationTestBase {

    private UUID fixtureWorkspace;
    private final java.util.List<UUID> fixtureUsers = new java.util.ArrayList<>();

    @Test
    void keyQueriesUseIndexesAndNotSequentialScans() {
        UUID workspace = UUID.randomUUID();
        fixtureWorkspace = workspace;
        UUID user = UUID.randomUUID();
        UUID sender = UUID.randomUUID();
        UUID peer = UUID.randomUUID();
        fixtureUsers.add(user);
        fixtureUsers.add(sender);
        fixtureUsers.add(peer);
        UUID chat = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        seedWorkspace(workspace, user, sender, peer);
        UUID recipientUser = UUID.randomUUID();
        migrator().update("""
                INSERT INTO auth.users (id, email, display_name) VALUES (?, ?, 'recipient')
                ON CONFLICT (id) DO NOTHING
                """, recipientUser, recipientUser + "@example.test");
        fixtureUsers.add(recipientUser);

        // A target keyed device plus enough noise that sequential scans lose.
        migrator().update("""
                INSERT INTO auth.devices
                       (id, user_id, name, platform, app_version, identity_key_alg,
                        identity_signing_key, identity_dh_key, identity_binding_signature,
                        fingerprint, status)
                VALUES (?, ?, 'plan', 'WEB', '0.7.0', 'Ed25519+X25519',
                        decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'),
                        decode(repeat('ef', 64), 'hex'), decode(repeat('12', 32), 'hex'),
                        'ACTIVE')
                """, device, user);
        migrator().update("""
                INSERT INTO auth.devices (id, user_id, name, platform, app_version,
                                          identity_key_alg, status)
                SELECT gen_random_uuid(), ?, 'noise', 'WEB', '0.7.0', 'LEGACY', 'ACTIVE'
                  FROM generate_series(1, 3000)
                """, recipientUser);
        migrator().update("""
                INSERT INTO auth.device_prekeys
                       (device_id, key_id, kind, public_key, signature, created_at, expires_at)
                SELECT ?, 'opk-' || g, 'ONE_TIME', decode(repeat('34', 32), 'hex'), NULL,
                       now() - (g || ' seconds')::interval, now() + interval '30 days'
                  FROM generate_series(1, 5) g
                """, device);
        // One OPK per noise device keeps the claim lookup genuinely selective.
        migrator().update("""
                INSERT INTO auth.device_prekeys
                       (device_id, key_id, kind, public_key, signature, created_at, expires_at)
                SELECT d.id, 'opk-noise', 'ONE_TIME', decode(repeat('35', 32), 'hex'), NULL,
                       now(), now() + interval '30 days'
                  FROM auth.devices d
                 WHERE d.user_id = ? AND d.id <> ?
                """, recipientUser, device);
        migrator().update("""
                INSERT INTO auth.device_prekeys
                       (device_id, key_id, kind, public_key, signature, created_at, expires_at)
                VALUES (?, 'spk-plan', 'SIGNED', decode(repeat('56', 32), 'hex'),
                        decode(repeat('78', 64), 'hex'), now(), now() + interval '30 days')
                ON CONFLICT DO NOTHING
                """, device);

        // Envelopes: 2000 distinct recipients + a handful for our device, so the
        // (recipient_device_id, created_at) index is genuinely selective.
        migrator().update("""
                INSERT INTO message.message_envelopes
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, created_at)
                SELECT gen_random_uuid(), gen_random_uuid(), ?, ?, ?, 'PAIRWISE_X3DH_DR',
                       1, 1, decode(repeat('9a', 16), 'hex'), '{}'::jsonb,
                       decode(repeat('bc', 272), 'hex'), now() - (g || ' seconds')::interval
                  FROM generate_series(1, 2000) g
                """, peer, workspace, chat);
        migrator().update("""
                INSERT INTO message.message_envelopes
                       (message_id, recipient_device_id, sender_device_id, workspace_id,
                        chat_id, scheme, sender_key_generation, recipient_key_generation,
                        session_id, header, ciphertext, created_at)
                SELECT gen_random_uuid(), ?, ?, ?, ?, 'PAIRWISE_X3DH_DR', 1, 1,
                       decode(repeat('9a', 16), 'hex'), '{}'::jsonb,
                       decode(repeat('bc', 272), 'hex'), now() - (g || ' seconds')::interval
                  FROM generate_series(1, 5) g
                """, device, peer, workspace, chat);

        String devicePlan = explain("""
                SELECT id FROM auth.devices WHERE user_id = ? AND status = 'ACTIVE'
                """, user);
        assertThat(devicePlan).contains("ix_devices_user_status").doesNotContain("Seq Scan");

        String identityPlan = explain("""
                SELECT id FROM auth.devices WHERE identity_signing_key = decode(?,'hex')
                """, "abababababababababababababababababababababababababababababababab");
        assertThat(identityPlan).contains("ux_devices_identity_sig")
                .doesNotContain("Seq Scan");

        String claimPlan = explain("""
                SELECT device_id, key_id FROM auth.device_prekeys
                 WHERE device_id = ? AND kind = 'ONE_TIME' AND consumed_at IS NULL
                   AND expires_at > now()
                 ORDER BY created_at LIMIT 1
                """, device);
        assertThat(claimPlan).contains("Index").doesNotContain("Seq Scan");
        assertThat(claimPlan).containsAnyOf("ix_prekeys_one_time_available",
                "device_prekeys_pkey");

        String envelopePlan = explain("""
                SELECT message_id FROM message.message_envelopes
                 WHERE recipient_device_id = ? AND created_at >= now() - interval '1 day'
                """, device);
        assertThat(envelopePlan).contains("recipient_device_id").contains("Index")
                .doesNotContain("Seq Scan");
    }

    /**
     * The noise rows live in the shared test database; remove them so later file/claim
     * tests are not slowed down by the plan fixtures.
     */
    @org.junit.jupiter.api.AfterEach
    void cleanUpNoise() {
        if (fixtureWorkspace != null) {
            migrator().update("DELETE FROM message.message_envelopes WHERE workspace_id = ?",
                    fixtureWorkspace);
            migrator().update("DELETE FROM workspace.workspaces WHERE id = ?",
                    fixtureWorkspace);
            fixtureWorkspace = null;
        }
        for (UUID user : fixtureUsers) {
            migrator().update("DELETE FROM auth.users WHERE id = ?", user);
        }
        fixtureUsers.clear();
    }

    private String explain(String sql, Object... args) {
        return migrator().queryForObject("EXPLAIN (FORMAT JSON) " + sql,
                (rs, rowNum) -> rs.getString(1), args);
    }

    private void seedWorkspace(UUID workspace, UUID owner, UUID... members) {
        migrator().update("""
                INSERT INTO auth.users (id, email, display_name) VALUES (?, ?, 'plan')
                ON CONFLICT (id) DO NOTHING
                """, owner, owner + "@example.test");
        for (UUID member : members) {
            migrator().update("""
                    INSERT INTO auth.users (id, email, display_name) VALUES (?, ?, 'plan')
                    ON CONFLICT (id) DO NOTHING
                    """, member, member + "@example.test");
        }
        migrator().update("""
                INSERT INTO workspace.workspaces (id, name, slug, security_mode, created_by)
                VALUES (?, 'Plan', ?, 'MANAGED', ?)
                """, workspace, "plan-" + workspace, owner);
        for (UUID member : members) {
            migrator().update("""
                    INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, 'ACTIVE')
                    ON CONFLICT (workspace_id, user_id) DO NOTHING
                    """, workspace, member, member.equals(owner) ? "OWNER" : "MEMBER");
        }
        UUID sender = members[0];
        UUID peer = members[1];
        UUID chat = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'MANAGED', 'plan', ?)
                """, chat, workspace, sender);
        for (UUID member : new UUID[] {sender, peer}) {
            migrator().update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
                    """, chat, workspace, member);
        }
        migrator().update(
                "INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)",
                chat, workspace);
    }
}
