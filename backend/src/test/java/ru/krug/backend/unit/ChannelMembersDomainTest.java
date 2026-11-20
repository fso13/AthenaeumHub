package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.domain.model.ChatInvite;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.InviteAcceptance;
import ru.krug.backend.chat.domain.service.ChatMemberPolicy;
import ru.krug.backend.chat.domain.service.InviteTokens;
import ru.krug.backend.ops.infrastructure.ratelimit.InMemoryRateLimiter;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.support.TestProperties;

/**
 * P0-1 (#79) domain rules: opaque invite tokens (hash only), invite status precedence,
 * channel role ceiling/last-OWNER invariants and the invite rate-limit windows.
 */
class ChannelMembersDomainTest {

    @Test
    void inviteTokensAreOpaqueAndOnlyTheHashIsStable() {
        String first = InviteTokens.newToken();
        String second = InviteTokens.newToken();
        assertThat(first).matches("^[A-Za-z0-9_-]{43}$");
        assertThat(second).isNotEqualTo(first);
        assertThat(InviteTokens.isWellFormed(first)).isTrue();
        assertThat(InviteTokens.isWellFormed(null)).isFalse();
        assertThat(InviteTokens.isWellFormed("short")).isFalse();
        assertThat(InviteTokens.isWellFormed("bad token with spaces")).isFalse();
        assertThat(InviteTokens.isWellFormed("a".repeat(129))).isFalse();

        String hash = InviteTokens.hash(first);
        assertThat(hash).matches("^[a-f0-9]{64}$");
        assertThat(InviteTokens.hash(first)).isEqualTo(hash).isNotEqualTo(first);
        assertThat(InviteTokens.hash(second)).isNotEqualTo(hash);
    }

    @Test
    void inviteStatusPrefersRevocationThenExpiryThenExhaustion() {
        Instant now = Instant.parse("2026-01-01T00:00:00Z");
        ChatInvite active = ChatInvite.reconstitute(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.MEMBER, 2, 0, now.plus(Duration.ofDays(1)), null, now,
                UUID.randomUUID());
        assertThat(active.status(now)).isEqualTo(ChatInvite.Status.ACTIVE);

        ChatInvite exhausted = ChatInvite.reconstitute(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.MEMBER, 1, 1, now.plus(Duration.ofDays(1)), null, now,
                UUID.randomUUID());
        assertThat(exhausted.status(now)).isEqualTo(ChatInvite.Status.EXHAUSTED);

        ChatInvite expired = ChatInvite.reconstitute(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.GUEST, null, 0, now.minusSeconds(1), null, now,
                UUID.randomUUID());
        assertThat(expired.status(now)).isEqualTo(ChatInvite.Status.EXPIRED);

        ChatInvite revoked = ChatInvite.reconstitute(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.MEMBER, null, 0, now.minusSeconds(1), now.minusSeconds(60), now,
                UUID.randomUUID());
        assertThat(revoked.status(now)).isEqualTo(ChatInvite.Status.REVOKED);

        assertThatThrownBy(() -> ChatInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.OWNER, null, now.plusSeconds(60), now, UUID.randomUUID()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ChatInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.MEMBER, 0, now.plusSeconds(60), now, UUID.randomUUID()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ChatInvite.create(UUID.randomUUID(), UUID.randomUUID(),
                ChatMember.Role.MEMBER, 1001, now.plusSeconds(60), now, UUID.randomUUID()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void inviteAcceptanceFailsClosedOnUnknownOutcomes() {
        assertThat(InviteAcceptance.parse("OK")).isEqualTo(InviteAcceptance.Outcome.OK);
        assertThat(InviteAcceptance.parse("EXPIRED")).isEqualTo(InviteAcceptance.Outcome.EXPIRED);
        assertThat(InviteAcceptance.parse("SOMETHING_NEW"))
                .isEqualTo(InviteAcceptance.Outcome.NOT_FOUND);
        assertThat(InviteAcceptance.parse(null)).isEqualTo(InviteAcceptance.Outcome.NOT_FOUND);
    }

    @Test
    void roleCeilingAndLastOwnerRules() {
        assertThat(ChatMemberPolicy.requireRole("MEMBER")).isEqualTo(ChatMember.Role.MEMBER);
        assertThat(ChatMemberPolicy.requireAddRole(null)).isEqualTo(ChatMember.Role.MEMBER);
        assertThat(ChatMemberPolicy.requireInviteRole(null)).isEqualTo(ChatMember.Role.MEMBER);
        assertThat(ChatMemberPolicy.requireInviteRole("GUEST"))
                .isEqualTo(ChatMember.Role.GUEST);

        assertCode(() -> ChatMemberPolicy.requireRole("SUPERUSER"),
                ErrorCode.VALIDATION_FAILED);
        assertCode(() -> ChatMemberPolicy.requireInviteRole("OWNER"),
                ErrorCode.VALIDATION_FAILED);
        assertCode(() -> ChatMemberPolicy.requireManager("MEMBER"), ErrorCode.FORBIDDEN);
        assertCode(() -> ChatMemberPolicy.requireCanAssign("ADMIN", ChatMember.Role.OWNER),
                ErrorCode.ROLE_CHANGE_FORBIDDEN);
        assertCode(() -> ChatMemberPolicy.requireCanAssign("ADMIN", ChatMember.Role.ADMIN),
                ErrorCode.ROLE_CHANGE_FORBIDDEN);
        assertCode(() -> ChatMemberPolicy.requireCanManageTarget("ADMIN",
                ChatMember.Role.OWNER), ErrorCode.ROLE_CHANGE_FORBIDDEN);
        assertCode(() -> ChatMemberPolicy.requireCanManageTarget("ADMIN",
                ChatMember.Role.ADMIN), ErrorCode.ROLE_CHANGE_FORBIDDEN);

        UUID actor = UUID.randomUUID();
        assertCode(() -> ChatMemberPolicy.requireNotSelf(actor, actor),
                ErrorCode.SELF_ACTION_FORBIDDEN);
        assertCode(() -> ChatMemberPolicy.requireOwnerPreserved(ChatMember.Role.OWNER,
                ChatMember.Role.MEMBER, 1), ErrorCode.LAST_OWNER);
        assertCode(() -> ChatMemberPolicy.requireOwnerPreservedOnRemoval(
                ChatMember.Role.OWNER, 1), ErrorCode.LAST_OWNER);

        // Not throwing: a distinct target, OWNER may assign OWNER, ADMIN manages MEMBER,
        // and a second owner allows a demotion.
        ChatMemberPolicy.requireNotSelf(actor, UUID.randomUUID());
        ChatMemberPolicy.requireCanAssign("OWNER", ChatMember.Role.OWNER);
        ChatMemberPolicy.requireCanManageTarget("ADMIN", ChatMember.Role.MEMBER);
        ChatMemberPolicy.requireOwnerPreserved(ChatMember.Role.OWNER, ChatMember.Role.MEMBER, 2);
        assertThat(ChatMemberPolicy.canManage("OWNER")).isTrue();
        assertThat(ChatMemberPolicy.canManage("MODERATOR")).isFalse();
    }

    private static void assertCode(Runnable action, String expectedCode) {
        assertThatThrownBy(action::run)
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).code()).isEqualTo(expectedCode));
    }

    @Test
    void inviteWindowsAreIndependentFromSendAndClaimWindows() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(TestProperties.defaults());
        Principal principal = new Principal(UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), "unit");
        UUID chatId = UUID.randomUUID();

        for (int index = 0; index < 10; index++) {
            limiter.checkInviteAccept(principal);
        }
        assertThatThrownBy(() -> limiter.checkInviteAccept(principal))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> {
                    DomainException error = (DomainException) ex;
                    assertThat(error.code()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(error.details().get("scope")).isEqualTo("user");
                });
        // A different user is not affected, and the message window is untouched.
        limiter.checkInviteAccept(new Principal(UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), "unit-2"));
        limiter.checkMessageSend(principal, chatId);

        for (int index = 0; index < 30; index++) {
            limiter.checkInviteCreate(principal, chatId);
        }
        assertThatThrownBy(() -> limiter.checkInviteCreate(principal, chatId))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).details().get("scope"))
                        .isEqualTo("chat"));
    }
}
