package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspaceInvitePreview;
import ru.krug.backend.workspace.domain.service.WorkspaceInvitePolicy;

/** #100: email-bound invites are normalized and always single-use. */
class WorkspaceInviteEmailDomainTest {

    private static final Instant NOW = Instant.parse("2026-11-23T10:00:00Z");

    @Test
    void emailIsNormalizedAndTheInviteIsSingleUse() {
        WorkspaceInvite invite = WorkspaceInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                Membership.Role.MEMBER, 1, NOW.plusSeconds(600), NOW, UUID.randomUUID(),
                "  Invitee@Krug.Test ");

        assertThat(invite.email()).isEqualTo("invitee@krug.test");
        assertThat(invite.isEmailBound()).isTrue();
        assertThat(invite.maxUses()).isEqualTo(1);
        assertThat(invite.status(NOW)).isEqualTo(WorkspaceInvite.Status.ACTIVE);
        assertThat(invite.status(NOW.plusSeconds(601)))
                .isEqualTo(WorkspaceInvite.Status.EXPIRED);
    }

    @Test
    void linkInviteStaysEmailLessAndMultiUse() {
        WorkspaceInvite invite = WorkspaceInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                Membership.Role.GUEST, 5, NOW.plusSeconds(600), NOW, UUID.randomUUID());

        assertThat(invite.email()).isNull();
        assertThat(invite.isEmailBound()).isFalse();
        assertThat(invite.maxUses()).isEqualTo(5);
    }

    @Test
    void emailInviteCannotBeMultiUse() {
        assertThatThrownBy(() -> WorkspaceInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                Membership.Role.MEMBER, 2, NOW.plusSeconds(600), NOW, UUID.randomUUID(),
                "invitee@krug.test"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("single-use");
    }

    @Test
    void ownerCanNeverBeInvited() {
        assertThatThrownBy(() -> WorkspaceInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                Membership.Role.OWNER, 1, NOW.plusSeconds(600), NOW, UUID.randomUUID(),
                "invitee@krug.test"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("OWNER");
    }

    @Test
    void policyValidatesAndNormalizesEmail() {
        assertThat(WorkspaceInvitePolicy.normalizeEmail(null)).isNull();
        assertThat(WorkspaceInvitePolicy.normalizeEmail("  ")).isNull();
        assertThat(WorkspaceInvitePolicy.normalizeEmail(" User@Example.COM "))
                .isEqualTo("user@example.com");
        assertThatThrownBy(() -> WorkspaceInvitePolicy.normalizeEmail("not-an-email"))
                .hasMessageContaining("email is invalid");
        assertThatThrownBy(() -> WorkspaceInvitePolicy.normalizeEmail("a".repeat(250)
                + "@example.com"))
                .hasMessageContaining("email is invalid");
    }

    @Test
    void previewParseFallsBackToNotFound() {
        assertThat(WorkspaceInvitePreview.Status.parse("EMAIL_MISMATCH"))
                .isEqualTo(WorkspaceInvitePreview.Status.NOT_FOUND);
        assertThat(WorkspaceInvitePreview.Status.parse("OK"))
                .isEqualTo(WorkspaceInvitePreview.Status.OK);
    }
}
