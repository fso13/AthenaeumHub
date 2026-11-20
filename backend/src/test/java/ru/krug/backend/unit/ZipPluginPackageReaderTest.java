package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

import ru.krug.backend.plugin.application.model.PluginArchive;
import ru.krug.backend.plugin.application.port.PluginPackageInvalidException;
import ru.krug.backend.plugin.infrastructure.archive.ZipPluginPackageReader;
import ru.krug.backend.support.PluginPackageTestSupport;

/** D1.2 (#86): ZIP hardening — traversal, symlink, bomb, limits and manifest validation. */
class ZipPluginPackageReaderTest {

    private final ZipPluginPackageReader reader = new ZipPluginPackageReader();

    @Test
    void readsValidPackageAndComputesDigests() {
        byte[] zip = PluginPackageTestSupport.packageZip("demo-panel", "index.html");

        PluginArchive archive = reader.read(zip);

        assertThat(archive.manifest().id()).isEqualTo("demo-panel");
        assertThat(archive.assets()).extracting(asset -> asset.path())
                .containsExactly("index.html", "assets/app.js", "assets/logo.svg");
        assertThat(archive.fileCount()).isEqualTo(3);
        assertThat(archive.unpackedSizeBytes()).isGreaterThan(0);
        assertThat(archive.archiveSha256()).matches("[0-9a-f]{64}");
        assertThat(archive.assets().get(1).contentType()).startsWith("text/javascript");
    }

    @Test
    void rejectsBuildArtifactThatIsNotAZip() {
        assertThatThrownBy(() -> reader.read("not a zip".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(PluginPackageInvalidException.class);
        assertThatThrownBy(() -> reader.read(new byte[0]))
                .isInstanceOf(PluginPackageInvalidException.class);
    }

    @Test
    void rejectsPathTraversalInsideTheArchive() {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json", PluginPackageTestSupport.DEFAULT_MANIFEST
                .getBytes(StandardCharsets.UTF_8));
        entries.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        entries.put("../evil.html", "<html/>".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zip(entries)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("archive path");
    }

    @Test
    void rejectsSymlinkAndEncryptedStyleMembers() {
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipWithSymlink(
                PluginPackageTestSupport.DEFAULT_MANIFEST, "index.html")))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("symlink");
    }

    @Test
    void rejectsZipBombBeyondUnpackedLimit() {
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipBomb(
                PluginPackageTestSupport.DEFAULT_MANIFEST, "index.html")))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("10 MiB");
    }

    @Test
    void rejectsTooManyFilesAndOversizedArchive() {
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.manyFiles(
                PluginPackageTestSupport.DEFAULT_MANIFEST, "index.html", 200)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("200");
        assertThatThrownBy(() -> reader.read(new byte[5 * 1024 * 1024 + 1]))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("5 MiB");
    }

    @Test
    void rejectsMissingManifestAndMissingEntry() {
        Map<String, byte[]> noManifest = new LinkedHashMap<>();
        noManifest.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zip(noManifest)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("manifest.json");

        Map<String, byte[]> entry = new LinkedHashMap<>();
        entry.put("manifest.json", PluginPackageTestSupport.manifest("demo-panel", "missing.html",
                        "[]", "[\"MANAGED\"]").getBytes(StandardCharsets.UTF_8));
        entry.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zip(entry)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("entry");
    }

    @Test
    void rejectsUnknownManifestKeysAndInvalidJson() {
        String unknownKey = PluginPackageTestSupport.DEFAULT_MANIFEST.replace(
                "\"modes\": [\"MANAGED\"]",
                "\"modes\": [\"MANAGED\"], \"signature\": \"abc\"");
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipWithText(
                unknownKey, "index.html", Map.of())))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("JSON");

        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipWithText(
                "{not json", "index.html", Map.of())))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("JSON");
    }

    @Test
    void rejectsUnsupportedPermissionAndMode() {
        Map<String, byte[]> permission = new LinkedHashMap<>();
        permission.put("manifest.json", PluginPackageTestSupport.manifest("demo-panel",
                        "index.html", "[\"chat.secrets.read\"]", "[\"MANAGED\"]")
                .getBytes(StandardCharsets.UTF_8));
        permission.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zip(permission)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("permission");

        Map<String, byte[]> mode = new LinkedHashMap<>();
        mode.put("manifest.json", PluginPackageTestSupport.manifest("demo-panel", "index.html",
                        "[]", "[\"SERVER\"]").getBytes(StandardCharsets.UTF_8));
        mode.put("index.html", "<html/>".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zip(mode)))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("mode");
    }

    @Test
    void rejectsMissingPermissionsAndModes() {
        String noPermissions = """
                {"id":"demo-panel","name":"Demo","version":"1.0.0","description":"d",
                 "author":"a","entry":"index.html","modes":["MANAGED"]}
                """;
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipWithText(
                noPermissions, "index.html", Map.of())))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("permissions");

        String noModes = """
                {"id":"demo-panel","name":"Demo","version":"1.0.0","description":"d",
                 "author":"a","entry":"index.html","permissions":[]}
                """;
        assertThatThrownBy(() -> reader.read(PluginPackageTestSupport.zipWithText(
                noModes, "index.html", Map.of())))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("modes");
    }

    @Test
    void rejectsDuplicatePaths() {
        byte[] zip = PluginPackageTestSupport.zipWithDuplicate(
                PluginPackageTestSupport.DEFAULT_MANIFEST);
        assertThatThrownBy(() -> reader.read(zip))
                .isInstanceOf(PluginPackageInvalidException.class)
                .hasMessageContaining("duplicate");
    }
}
