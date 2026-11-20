package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginContentTypes;
import ru.krug.backend.plugin.domain.model.PluginKind;
import ru.krug.backend.plugin.domain.model.PluginManifest;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginPaths;
import ru.krug.backend.plugin.domain.model.PluginState;

/** D1.2 (#86): manifest/path/content-type invariants for static external packages. */
class PluginPackageDomainTest {

    private static PluginManifest manifest(String entry, List<String> permissions,
                                           List<PluginMode> modes) {
        return new PluginManifest("demo-panel", "Demo panel", "1.0.0",
                "Static demo", "Sova", entry, permissions, modes);
    }

    @Test
    void validManifestKeepsClosedPermissionsAndModes() {
        PluginManifest manifest = manifest("index.html",
                List.of("chat.messages.read", "chat.members.read"),
                List.of(PluginMode.MANAGED));

        assertThat(manifest.entry()).isEqualTo("index.html");
        assertThat(manifest.permissions()).containsExactly("chat.messages.read",
                "chat.members.read");
        assertThat(manifest.modes()).containsExactly(PluginMode.MANAGED);
    }

    @Test
    void manifestRejectsUnsafeEntryAndUnknownMetadata() {
        assertThatThrownBy(() -> manifest("../index.html", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("entry");
        assertThatThrownBy(() -> manifest("/index.html", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("entry");
        assertThatThrownBy(() -> manifest("index.htm", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(".html");
        assertThatThrownBy(() -> manifest("index.html", List.of("chat.secrets.read"),
                List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("permission");
        assertThatThrownBy(() -> manifest("index.html", List.of("chat.messages.read",
                "chat.messages.read"), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("duplicate");
        assertThatThrownBy(() -> manifest("index.html", List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mode");
        assertThatThrownBy(() -> new PluginManifest("Demo!", "Demo", "1.0.0", "d", "a",
                "index.html", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("slug");
        assertThatThrownBy(() -> new PluginManifest("demo", "Demo", "v1", "d", "a",
                "index.html", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("version");
        assertThatThrownBy(() -> new PluginManifest("demo", "<b>Demo</b>", "1.0.0", "d", "a",
                "index.html", List.of(), List.of(PluginMode.MANAGED)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("plain text");
    }

    @Test
    void pathGrammarRejectsTraversalAbsoluteAndBackslash() {
        assertThat(PluginPaths.requireAssetPath("assets/app.js", "path"))
                .isEqualTo("assets/app.js");
        for (String unsafe : List.of("../secret", "assets/../../secret", "/etc/passwd",
                "assets\\app.js", "assets//app.js", "./app.js", "assets/.hidden",
                "assets/app.js/", "assets/привет.js")) {
            assertThatThrownBy(() -> PluginPaths.requireAssetPath(unsafe, "path"))
                    .as(unsafe)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(PluginPaths.normalizeRequestPath("/index.html")).isEqualTo("index.html");
        assertThatThrownBy(() -> PluginPaths.normalizeRequestPath("/../index.html"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void contentTypesAreClosedAndUnknownIsAttachment() {
        assertThat(PluginContentTypes.forPath("index.html")).startsWith("text/html");
        assertThat(PluginContentTypes.forPath("app.js")).startsWith("text/javascript");
        assertThat(PluginContentTypes.forPath("logo.svg")).isEqualTo("image/svg+xml");
        assertThat(PluginContentTypes.forPath("payload.exe")).isEqualTo("application/octet-stream");
        assertThat(PluginContentTypes.inline("text/html; charset=utf-8")).isTrue();
        assertThat(PluginContentTypes.inline("application/octet-stream")).isFalse();
    }

    @Test
    void externalPluginRequiresPackageMetadataAndBuiltinRejectsIt() {
        Plugin external = new Plugin("demo-panel", "Demo panel", "desc", null,
                List.of("chat.messages.read"), List.of(PluginMode.MANAGED), PluginState.ACTIVE,
                PluginKind.EXTERNAL, "1.0.0", "Sova", "index.html");
        assertThat(external.external()).isTrue();
        assertThat(external.version()).isEqualTo("1.0.0");

        assertThatThrownBy(() -> new Plugin("demo-panel", "Demo", "desc", null,
                List.of("chat.messages.read"), List.of(PluginMode.MANAGED), PluginState.ACTIVE,
                PluginKind.EXTERNAL, null, "Sova", "index.html"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("version");
        assertThatThrownBy(() -> new Plugin("polls", "Опросы", "desc", null,
                List.of("MESSAGES"), List.of(PluginMode.MANAGED), PluginState.ACTIVE,
                PluginKind.BUILTIN, "1.0.0", null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("package metadata");
    }
}
