package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.infrastructure.ratelimit.InMemoryRateLimiter;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.support.TestProperties;

/** #100: invite-email windows are per workspace/per address; preview is per IP. */
class WorkspaceInviteRateLimitTest {

    private static final Principal OWNER =
            new Principal(UUID.randomUUID(), null, null, "request");

    @Test
    void emailSendIsBoundedPerAddressAndPerWorkspace() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withInviteEmailRateLimit(3, Duration.ofHours(1), 1,
                        Duration.ofHours(1), 10, Duration.ofMinutes(1)));
        UUID workspace = UUID.randomUUID();

        assertThatCode(() -> limiter.checkInviteEmailSend(OWNER, workspace, "a@krug.test"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> limiter.checkInviteEmailSend(OWNER, workspace,
                "a@krug.test"))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("RATE_LIMITED");
                    assertThat(ex.details()).containsEntry("scope", "email");
                });

        // A different address is allowed until the workspace window (2) is exhausted.
        assertThatCode(() -> limiter.checkInviteEmailSend(OWNER, workspace, "b@krug.test"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> limiter.checkInviteEmailSend(OWNER, workspace,
                "c@krug.test"))
                .isInstanceOfSatisfying(DomainException.class, ex ->
                        assertThat(ex.details()).containsEntry("scope", "workspace"));
    }

    @Test
    void previewIsBoundedPerIp() {
        InMemoryRateLimiter limiter = new InMemoryRateLimiter(
                TestProperties.withInviteEmailRateLimit(10, Duration.ofHours(1), 10,
                        Duration.ofHours(1), 1, Duration.ofMinutes(1)));
        assertThatCode(() -> limiter.checkInvitePreview("10.0.0.1"))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> limiter.checkInvitePreview("10.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("RATE_LIMITED");
                    assertThat(ex.details()).containsEntry("scope", "ip");
                });
        assertThatCode(() -> limiter.checkInvitePreview("10.0.0.2"))
                .doesNotThrowAnyException();
    }
}
