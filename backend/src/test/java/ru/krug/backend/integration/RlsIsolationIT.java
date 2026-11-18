package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.dao.DataAccessException;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * RLS proof under the real krug_app role: with tenant A context, tenant B rows are invisible
 * and writes into B are rejected; without context nothing is visible.
 */
@ActiveProfiles("test")
class RlsIsolationIT extends IntegrationTestBase {

    @Test
    void crossTenantReadsReturnZeroRows() throws Exception {
        SessionResponse a = devSession();
        SessionResponse b = devSession();
        sendMessage(a, a.chat().id(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "A-only");

        int visibleMessages = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM message.messages", Integer.class));
        assertThat(visibleMessages).isEqualTo(1);

        int foreignMessages = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject(
                        "SELECT count(*) FROM message.messages WHERE workspace_id = ?",
                        Integer.class, b.workspace().id()));
        assertThat(foreignMessages).isZero();

        int foreignChats = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM chat.chats WHERE id = ?",
                        Integer.class, b.chat().id()));
        assertThat(foreignChats).isZero();

        int usersVisible = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject("SELECT count(*) FROM auth.users", Integer.class));
        assertThat(usersVisible).isEqualTo(1);

        int foreignIdempotency = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject(
                        "SELECT count(*) FROM ops.idempotency_keys WHERE user_id = ?",
                        Integer.class, b.user().id()));
        assertThat(foreignIdempotency).isZero();
    }

    @Test
    void withoutTenantContextNothingIsVisible() throws Exception {
        devSession();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM chat.chats", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM message.messages", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM workspace.workspaces", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM auth.users", Integer.class)).isZero();
    }

    @Test
    void writingIntoAnotherTenantIsRejectedByRls() throws Exception {
        SessionResponse a = devSession();
        SessionResponse b = devSession();

        assertThatThrownBy(() -> inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO message.messages
                               (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme,
                                body_ciphertext)
                        VALUES (?, ?, ?, 999, ?, 'TEXT', 'MANAGED', decode('00', 'hex'))
                        """, UUID.randomUUID(), b.workspace().id(), b.chat().id(), a.user().id())))
                .isInstanceOf(DataAccessException.class);

        assertThatThrownBy(() -> inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.update("INSERT INTO chat.read_receipts"
                                + " (chat_id, workspace_id, user_id, last_read_seq) VALUES (?, ?, ?, 1)",
                        b.chat().id(), b.workspace().id(), a.user().id())))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void updatesAndDeletesCannotReachAnotherTenant() throws Exception {
        SessionResponse a = devSession();
        SessionResponse b = devSession();

        int updated = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.update("UPDATE chat.chats SET name = 'hijacked' WHERE id = ?",
                        b.chat().id()));
        assertThat(updated).isZero();

        int deleted = inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.update("DELETE FROM message.messages WHERE workspace_id = ?",
                        b.workspace().id()));
        assertThat(deleted).isZero();

        assertThat(migrator().queryForObject("SELECT name FROM chat.chats WHERE id = ?",
                String.class, b.chat().id())).isNotEqualTo("hijacked");
    }
}
