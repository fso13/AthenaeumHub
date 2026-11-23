package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseCookie;

import ru.krug.backend.auth.api.RefreshCookieFactory;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.auth.infrastructure.config.AuthBffSettingsAdapter;
import ru.krug.backend.support.AuthBffTestData;

/** #103: cookie flags are configuration-driven and tokens cannot inject headers. */
class RefreshCookieFactoryTest {

    private static final String TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

    @Test
    void devCookieIsHttpOnlySameSiteLaxAndNotSecure() {
        ResponseCookie cookie = factory(cookie(false, "Lax", Duration.ofMinutes(30)))
                .issue(TOKEN);

        assertThat(cookie.getName()).isEqualTo("sova_refresh");
        assertThat(cookie.getValue()).isEqualTo(TOKEN);
        assertThat(cookie.isHttpOnly()).isTrue();
        assertThat(cookie.isSecure()).isFalse();
        assertThat(cookie.getSameSite()).isEqualTo("Lax");
        assertThat(cookie.getPath()).isEqualTo("/api/v1/auth");
        assertThat(cookie.getMaxAge()).isEqualTo(Duration.ofMinutes(30));
        assertThat(cookie.getDomain()).isNull();
    }

    @Test
    void prodCookieIsSecureAndTheClearCookieExpiresImmediately() {
        RefreshCookieFactory factory = factory(cookie(true, "Lax", Duration.ofMinutes(30)));
        ResponseCookie cookie = factory.issue(TOKEN);
        assertThat(cookie.isSecure()).isTrue();

        ResponseCookie clear = factory.clear();
        assertThat(clear.getValue()).isEmpty();
        assertThat(clear.getMaxAge()).isZero();
        assertThat(clear.isHttpOnly()).isTrue();
        assertThat(clear.getPath()).isEqualTo("/api/v1/auth");
        assertThat(clear.isSecure()).isTrue();
    }

    @Test
    void sameSiteNoneRequiresSecure() {
        assertThatThrownBy(() -> cookie(false, "None", Duration.ofMinutes(30)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("requires secure=true");
    }

    @Test
    void unsafeTokenValuesAreRejectedWithoutEchoingThem() {
        RefreshCookieFactory factory = factory(cookie(true, "Lax", Duration.ofMinutes(30)));
        for (String value : new String[]{"a;b", "a\r\nSet-Cookie: x=y", "with space"}) {
            assertThatThrownBy(() -> factory.issue(value))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageNotContaining(value);
        }
        assertThatThrownBy(() -> factory.issue(""))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> factory.issue(null))
                .isInstanceOf(IllegalStateException.class);
    }

    private static AuthBffProperties cookie(boolean secure, String sameSite, Duration maxAge) {
        AuthBffProperties base = AuthBffTestData.properties();
        return new AuthBffProperties(
                base.registrationEnabled(), base.trustForwardedFor(), base.pendingSessionTtl(),
                base.keycloak(), base.mail(), base.code(), base.twoFactor(), base.rateLimit(),
                base.cleanup(),
                new AuthBffProperties.RefreshCookie("sova_refresh", "/api/v1/auth", secure,
                        sameSite, maxAge));
    }

    private static RefreshCookieFactory factory(AuthBffProperties properties) {
        return new RefreshCookieFactory(new AuthBffSettingsAdapter(properties));
    }
}
