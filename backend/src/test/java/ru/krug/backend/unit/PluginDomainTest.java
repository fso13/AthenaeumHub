package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAvailability;
import ru.krug.backend.plugin.domain.model.PluginAvailabilityPolicy;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginPermission;
import ru.krug.backend.plugin.domain.model.PluginState;
import ru.krug.backend.plugin.domain.model.PluginUnavailableReason;

/** D1.1 (#69): plugin catalog invariants and mode availability. No execution involved. */
class PluginDomainTest {

    private static Plugin plugin(PluginState state, PluginMode... modes) {
        return new Plugin("polls", "Опросы", "Голосования в чате", "poll",
                List.of(PluginPermission.MESSAGES), List.of(modes), state);
    }

    @Test
    void managedPluginIsAvailableInManagedChat() {
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(
                plugin(PluginState.ACTIVE, PluginMode.MANAGED), PluginMode.MANAGED);

        assertThat(availability.available()).isTrue();
        assertThat(availability.reason()).isNull();
    }

    @Test
    void managedOnlyPluginIsUnavailableInE2eeChat() {
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(
                plugin(PluginState.ACTIVE, PluginMode.MANAGED), PluginMode.E2EE);

        assertThat(availability.available()).isFalse();
        assertThat(availability.reason())
                .isEqualTo(PluginUnavailableReason.PLUGIN_NOT_AVAILABLE);
    }

    @Test
    void clientOnlyPluginCanBeAvailableInE2eeChat() {
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(
                plugin(PluginState.ACTIVE, PluginMode.MANAGED, PluginMode.E2EE),
                PluginMode.E2EE);

        assertThat(availability.available()).isTrue();
        assertThat(availability.reason()).isNull();
    }

    @Test
    void disabledCatalogStateWinsOverModeCheck() {
        PluginAvailability inManaged = PluginAvailabilityPolicy.evaluate(
                plugin(PluginState.DISABLED, PluginMode.MANAGED), PluginMode.MANAGED);
        PluginAvailability inE2ee = PluginAvailabilityPolicy.evaluate(
                plugin(PluginState.DISABLED, PluginMode.MANAGED), PluginMode.E2EE);

        assertThat(inManaged.available()).isFalse();
        assertThat(inManaged.reason()).isEqualTo(PluginUnavailableReason.PLUGIN_DISABLED);
        assertThat(inE2ee.reason()).isEqualTo(PluginUnavailableReason.PLUGIN_DISABLED);
    }

    @Test
    void pluginRequiresSlugNameDescriptionAndAtLeastOneMode() {
        assertThatThrownBy(() -> new Plugin("Polls!", "Опросы", "desc", null,
                List.of(), List.of(PluginMode.MANAGED), PluginState.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("slug");
        assertThatThrownBy(() -> new Plugin("polls", "  ", "desc", null,
                List.of(), List.of(PluginMode.MANAGED), PluginState.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("name");
        assertThatThrownBy(() -> new Plugin("polls", "Опросы", " ", null,
                List.of(), List.of(PluginMode.MANAGED), PluginState.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("description");
        assertThatThrownBy(() -> new Plugin("polls", "Опросы", "desc", null,
                List.of(), List.of(), PluginState.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mode");
    }

    @Test
    void pluginCopiesMutableCollectionsAndSupportsModes() {
        List<PluginPermission> permissions = new ArrayList<>(List.of(PluginPermission.MESSAGES));
        List<PluginMode> modes = new ArrayList<>(List.of(PluginMode.MANAGED));
        Plugin plugin = new Plugin("polls", "Опросы", "desc", null, permissions, modes,
                PluginState.ACTIVE);

        permissions.add(PluginPermission.FILES);
        modes.add(PluginMode.E2EE);

        assertThat(plugin.permissions()).containsExactly(PluginPermission.MESSAGES);
        assertThat(plugin.modes()).containsExactly(PluginMode.MANAGED);
        assertThat(plugin.supports(PluginMode.MANAGED)).isTrue();
        assertThat(plugin.supports(PluginMode.E2EE)).isFalse();
    }
}
