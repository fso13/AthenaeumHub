package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;

class KeycloakIdentityFactoryTest {

    private final KeycloakIdentityFactory factory = new KeycloakIdentityFactory();

    @Test
    void localUserIdIsDeterministicPerSubject() {
        UUID first = factory.localUserId("subject-1");
        UUID second = factory.localUserId("subject-1");
        UUID other = factory.localUserId("subject-2");
        assertThat(first).isEqualTo(second).isNotEqualTo(other);
    }

    @Test
    void usesEmailWhenPresent() {
        KeycloakIdentity identity = new KeycloakIdentity("s", "User@Example.com", true,
                "user", "User");
        assertThat(factory.email(identity)).isEqualTo("user@example.com");
    }

    @Test
    void fallsBackToPreferredUsernameWhenEmailIsMissing() {
        KeycloakIdentity identity = new KeycloakIdentity("s", null, false, "testuser", null);
        assertThat(factory.email(identity)).isEqualTo("testuser@keycloak.local");
        assertThat(factory.email(new KeycloakIdentity("s", " ", false, "testuser", null)))
                .isEqualTo("testuser@keycloak.local");
    }

    @Test
    void usesPreferredUsernameAsEmailWhenItIsAnEmailAddress() {
        KeycloakIdentity identity = new KeycloakIdentity("s", null, false,
                "User@Example.com", null);
        assertThat(factory.email(identity)).isEqualTo("user@example.com");
    }

    @Test
    void collisionEmailIncludesStableSubjectSuffix() {
        KeycloakIdentity identity = new KeycloakIdentity("subject-x", "same@example.com", true,
                "same", "Same");
        String first = factory.collisionEmail(identity);
        String second = factory.collisionEmail(identity);
        assertThat(first).isEqualTo(second).startsWith("same.").endsWith("@keycloak.local");
    }

    @Test
    void displayNameIsTrimmedAndLimitedTo80Characters() {
        KeycloakIdentity longName = new KeycloakIdentity("s", "u@example.com", true, "u",
                "x".repeat(120));
        assertThat(factory.displayName(longName)).hasSize(80);
        assertThat(factory.displayName(new KeycloakIdentity("s", null, false, "preferred", null)))
                .isEqualTo("preferred");
        assertThat(factory.displayName(new KeycloakIdentity("s", null, false, null, null)))
                .isEqualTo("Пользователь");
    }

    @Test
    void validatesEmailShape() {
        assertThat(KeycloakIdentityFactory.isEmail("a@b.co")).isTrue();
        assertThat(KeycloakIdentityFactory.isEmail("not-an-email")).isFalse();
        assertThat(KeycloakIdentityFactory.isEmail("a@@b.co")).isFalse();
        assertThat(KeycloakIdentityFactory.isEmail(null)).isFalse();
    }
}
