package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.service.WorkspaceInvitePolicy;
import ru.krug.backend.workspace.domain.service.WorkspaceInviteTokens;

/** P0-4: workspace settings value rules, role matrix defaults and invite-link policy. */
class WorkspaceSettingsDomainTest {

    private final UUID workspaceId = UUID.randomUUID();
    private final UUID ownerId = UUID.randomUUID();

    @Test
    void descriptionIsTrimmedBoundedAndClearableViaPresenceFlag() {
        Workspace workspace = Workspace.create(workspaceId, "Name", "slug",
                Workspace.SecurityMode.MANAGED, ownerId);
        assertThat(workspace.description()).isNull();

        Workspace described = workspace.withSettings(null, "  hello  ", true, null, false);
        assertThat(described.description()).isEqualTo("hello");
        Workspace cleared = described.withSettings(null, null, true, null, false);
        assertThat(cleared.description()).isNull();
        Workspace kept = described.withSettings("New", null, false, null, false);
        assertThat(kept.name()).isEqualTo("New");
        assertThat(kept.description()).isEqualTo("hello");
    }

    @Test
    void descriptionBoundsAndControlCharactersAreRejected() {
        Workspace workspace = Workspace.create(workspaceId, "Name", "slug",
                Workspace.SecurityMode.MANAGED, ownerId);
        assertThatThrownBy(() -> workspace.withSettings(null, "x".repeat(501), true, null, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> workspace.withSettings(null, "bad\u0000", true, null, false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void logoAndDescriptionCanBeClearedWhileKeepingOtherFields() {
        Workspace workspace = Workspace.reconstitute(workspaceId, "Name", "slug", "desc",
                UUID.randomUUID(), Workspace.SecurityMode.MANAGED, Workspace.Status.ACTIVE,
                ownerId);
        Workspace updated = workspace.withSettings(null, null, false, null, true);
        assertThat(updated.logoFileId()).isNull();
        assertThat(updated.description()).isEqualTo("desc");
    }

    @Test
    void permissionMatrixDefaultsAreOwnerAndAdminTrueMemberFalse() {
        for (WorkspacePermission permission : WorkspacePermission.values()) {
            assertThat(WorkspacePermission.defaultFor(Membership.Role.OWNER, permission)).isTrue();
            assertThat(WorkspacePermission.defaultFor(Membership.Role.ADMIN, permission)).isTrue();
            assertThat(WorkspacePermission.defaultFor(Membership.Role.MEMBER, permission))
                    .isFalse();
            assertThat(WorkspacePermission.defaultFor(Membership.Role.GUEST, permission))
                    .isFalse();
        }
        assertThat(WorkspacePermission.parse("manage_invites"))
                .contains(WorkspacePermission.MANAGE_INVITES);
        assertThat(WorkspacePermission.parse("unknown")).isEmpty();
    }

    @Test
    void inviteTokensAreOpaqueAndHashToSha256() {
        String token = WorkspaceInviteTokens.newToken();
        assertThat(token).hasSize(43).matches("[A-Za-z0-9_-]+");
        assertThat(WorkspaceInviteTokens.isWellFormed(token)).isTrue();
        assertThat(WorkspaceInviteTokens.isWellFormed("short")).isFalse();
        assertThat(WorkspaceInviteTokens.hash(token)).hasSize(64).matches("[a-f0-9]{64}")
                .isNotEqualTo(token);
    }

    @ParameterizedTest
    @CsvSource({
            "OWNER,ADMIN,true",
            "OWNER,MEMBER,true",
            "OWNER,GUEST,true",
            "ADMIN,ADMIN,false",
            "ADMIN,MEMBER,true",
            "ADMIN,GUEST,true"
    })
    void inviteRoleCeilingMatchesOwnerAdminRules(String actor, String target, boolean allowed) {
        if (allowed) {
            WorkspaceInvitePolicy.requireCanInvite(Membership.Role.valueOf(actor),
                    Membership.Role.valueOf(target));
        } else {
            assertThatThrownBy(() -> WorkspaceInvitePolicy.requireCanInvite(
                    Membership.Role.valueOf(actor), Membership.Role.valueOf(target)))
                    .isInstanceOf(ru.krug.backend.shared.error.DomainException.class);
        }
    }

    @Test
    void inviteStatusPrefersRevocationThenExpiryThenExhaustion() {
        Instant now = Instant.parse("2026-06-01T00:00:00Z");
        WorkspaceInvite invite = WorkspaceInvite.create(UUID.randomUUID(), workspaceId,
                Membership.Role.MEMBER, 1, now.minusSeconds(1), now.minusSeconds(10), ownerId);
        assertThat(invite.status(now)).isEqualTo(WorkspaceInvite.Status.EXPIRED);
        WorkspaceInvite exhausted = WorkspaceInvite.reconstitute(UUID.randomUUID(), workspaceId,
                Membership.Role.MEMBER, 1, 1, now.plusSeconds(600), null, now, ownerId);
        assertThat(exhausted.status(now)).isEqualTo(WorkspaceInvite.Status.EXHAUSTED);
        WorkspaceInvite revoked = WorkspaceInvite.reconstitute(UUID.randomUUID(), workspaceId,
                Membership.Role.MEMBER, 1, 1, now.plusSeconds(600), now, now, ownerId);
        assertThat(revoked.status(now)).isEqualTo(WorkspaceInvite.Status.REVOKED);
    }
}
