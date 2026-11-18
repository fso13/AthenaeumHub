package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtException;

import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;
import ru.krug.backend.shared.infrastructure.security.JwtService;
import ru.krug.backend.support.TestProperties;

class JwtServiceTest {

    private static final Instant NOW = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS);

    @Test
    void issuesSignedTokenWithDeviceAndWorkspaceClaims() {
        JwtService service = new JwtService(TestProperties.defaults(), () -> NOW);
        UUID userId = UUID.randomUUID();
        UUID deviceId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();

        IssuedToken issued = service.issue(userId, deviceId, workspaceId);
        Jwt decoded = service.decoder().decode(issued.accessToken());

        assertThat(decoded.getSubject()).isEqualTo(userId.toString());
        assertThat(decoded.getClaimAsString("device_id")).isEqualTo(deviceId.toString());
        assertThat(decoded.getClaimAsString("workspace_id")).isEqualTo(workspaceId.toString());
        assertThat(decoded.getClaimAsString("iss")).isEqualTo("krug-dev");
        assertThat(decoded.getAudience()).contains("krug-api");
        assertThat(issued.expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(15)));
        assertThat(decoded.getExpiresAt()).isEqualTo(issued.expiresAt());
    }

    @Test
    void rejectsTamperedToken() {
        JwtService service = new JwtService(TestProperties.defaults(), () -> NOW);
        String token = service.issue(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID())
                .accessToken();
        String tampered = token.substring(0, token.length() - 2) + "xx";
        assertThatThrownBy(() -> service.decoder().decode(tampered))
                .isInstanceOf(JwtException.class);
    }

    @Test
    void rejectsShortSecret() {
        KrugProperties base = TestProperties.defaults();
        KrugProperties weak = new KrugProperties(
                new KrugProperties.Auth("short", "krug-dev", "krug-api", Duration.ofMinutes(15)),
                base.content(), base.dev(), base.rateLimit(), base.outbox(), base.oidc(),
                base.e2ee());
        assertThatThrownBy(() -> new JwtService(weak, Clock.systemUTC()::instant))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("KRUG_AUTH_JWT_SECRET");
    }
}
