package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.application.service.DevIdentityFactory;

class DevIdentityFactoryTest {

    private final DevIdentityFactory ids = new DevIdentityFactory();

    @Test
    void idsAreDeterministicAndCaseInsensitive() {
        String key = ids.devKey("Дмитрий");
        assertThat(ids.id("user", key)).isEqualTo(ids.id("user", ids.devKey("  дмитрий ")));
        assertThat(ids.id("workspace", key)).isNotEqualTo(ids.id("user", key));
        assertThat(ids.id("user", key)).isNotEqualTo(ids.id("user", ids.devKey("Ева")));
    }

    @Test
    void producesRfc4122Variant5Uuids() {
        UUID id = ids.id("chat", "some-key");
        assertThat(id.version()).isEqualTo(5);
        assertThat(id.variant()).isEqualTo(2);
    }

    @Test
    void emailAndSlugAreStableAndDevScoped() {
        String key = ids.devKey("Дмитрий");
        assertThat(ids.emailFor(key)).isEqualTo(ids.emailFor(key)).endsWith("@krug.local");
        assertThat(ids.slugFor(key)).isEqualTo(ids.slugFor(key)).startsWith("dev-");
    }
}
