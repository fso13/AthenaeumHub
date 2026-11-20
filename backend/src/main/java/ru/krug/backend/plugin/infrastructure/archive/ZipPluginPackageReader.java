package ru.krug.backend.plugin.infrastructure.archive;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.commons.compress.archivers.zip.ZipFile;
import org.apache.commons.compress.utils.SeekableInMemoryByteChannel;
import org.springframework.stereotype.Component;

import ru.krug.backend.plugin.application.model.PluginArchive;
import ru.krug.backend.plugin.application.port.PluginPackageArchivePort;
import ru.krug.backend.plugin.application.port.PluginPackageInvalidException;
import ru.krug.backend.plugin.domain.model.PluginAsset;
import ru.krug.backend.plugin.domain.model.PluginManifest;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginPaths;

/**
 * Strict, in-memory ZIP reader for external plugin packages.
 *
 * <p>Security properties:</p>
 * <ul>
 *   <li>the ZIP is never extracted to the server filesystem;</li>
 *   <li>absolute paths, backslashes, {@code .}/{@code ..} segments and duplicate paths
 *       are rejected by {@link PluginPaths};</li>
 *   <li>Unix symlinks and encrypted entries are rejected;</li>
 *   <li>the streamed (not declared) uncompressed size is bounded to 10 MiB, so a zip bomb
 *       cannot exhaust memory;</li>
 *   <li>at most 200 files and 400 total entries are accepted.</li>
 * </ul>
 */
@Component
public class ZipPluginPackageReader implements PluginPackageArchivePort {

    public static final long MAX_ARCHIVE_BYTES = 5L * 1024 * 1024;
    public static final long MAX_UNPACKED_BYTES = 10L * 1024 * 1024;
    public static final int MAX_FILES = 200;
    public static final int MAX_ENTRIES = 400;
    public static final int MAX_MANIFEST_BYTES = 64 * 1024;

    private static final String MANIFEST = "manifest.json";

    private final JsonMapper json = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build();

    @Override
    public PluginArchive read(byte[] archiveBytes) {
        if (archiveBytes == null || archiveBytes.length == 0) {
            throw invalid("archive is empty");
        }
        if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
            throw invalid("archive exceeds the 5 MiB limit");
        }
        try (ZipFile zip = new ZipFile(new SeekableInMemoryByteChannel(archiveBytes))) {
            return readEntries(zip, archiveBytes);
        } catch (IOException ex) {
            throw new PluginPackageInvalidException("archive is not a readable ZIP", ex);
        }
    }

    private PluginArchive readEntries(ZipFile zip, byte[] archiveBytes) throws IOException {
        List<ZipArchiveEntry> entries = Collections.list(zip.getEntries());
        if (entries.size() > MAX_ENTRIES) {
            throw invalid("archive contains too many entries");
        }

        Map<String, byte[]> files = new LinkedHashMap<>();
        byte[] manifestBytes = null;
        long declaredTotal = 0;
        long actualTotal = 0;
        int fileCount = 0;

        for (ZipArchiveEntry entry : entries) {
            if (entry.isDirectory()) {
                continue;
            }
            if (entry.isUnixSymlink()) {
                throw invalid("archive contains a symlink");
            }
            if (entry.getGeneralPurposeBit().usesEncryption()) {
                throw invalid("encrypted archives are not supported");
            }
            if (!zip.canReadEntryData(entry)) {
                throw invalid("archive uses an unsupported compression method");
            }
            String path;
            try {
                path = PluginPaths.requireAssetPath(entry.getName(), "archive path");
            } catch (IllegalArgumentException ex) {
                throw new PluginPackageInvalidException(ex.getMessage(), ex);
            }

            long declared = entry.getSize();
            if (declared > MAX_UNPACKED_BYTES) {
                throw invalid("archive member exceeds the 10 MiB limit");
            }
            if (declared > 0) {
                declaredTotal += declared;
                if (declaredTotal > MAX_UNPACKED_BYTES) {
                    throw invalid("archive expands beyond the 10 MiB limit");
                }
            }

            byte[] content;
            try (InputStream input = zip.getInputStream(entry)) {
                content = readBounded(input, MAX_UNPACKED_BYTES - actualTotal, path);
            }
            actualTotal += content.length;
            if (actualTotal > MAX_UNPACKED_BYTES) {
                throw invalid("archive expands beyond the 10 MiB limit");
            }

            if (MANIFEST.equals(path)) {
                if (manifestBytes != null) {
                    throw invalid("archive contains more than one manifest");
                }
                if (content.length > MAX_MANIFEST_BYTES) {
                    throw invalid("manifest is too large");
                }
                manifestBytes = content;
                continue;
            }
            fileCount++;
            if (fileCount > MAX_FILES) {
                throw invalid("archive contains more than 200 files");
            }
            if (files.putIfAbsent(path, content) != null) {
                throw invalid("archive contains a duplicate path");
            }
        }

        if (manifestBytes == null) {
            throw invalid("manifest.json is missing");
        }
        PluginManifest manifest = parseManifest(manifestBytes);
        if (!files.containsKey(manifest.entry())) {
            throw invalid("manifest entry does not exist in the archive");
        }

        List<PluginAsset> assets = files.entrySet().stream()
                .map(file -> new PluginAsset(file.getKey(),
                        null, file.getValue(), null))
                .toList();
        return new PluginArchive(manifest, assets, PluginAsset.sha256(archiveBytes),
                archiveBytes.length, actualTotal, fileCount);
    }

    private byte[] readBounded(InputStream input, long remaining, String path)
            throws IOException {
        if (remaining < 0) {
            throw invalid("archive expands beyond the 10 MiB limit");
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream(
                (int) Math.min(remaining, 8192));
        byte[] buffer = new byte[8192];
        long total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > remaining) {
                throw invalid("archive member " + path + " exceeds the size limit");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private PluginManifest parseManifest(byte[] manifestBytes) {
        ManifestJson jsonManifest;
        try {
            jsonManifest = json.readValue(manifestBytes, ManifestJson.class);
        } catch (JsonProcessingException ex) {
            throw new PluginPackageInvalidException("manifest.json is not valid JSON", ex);
        } catch (IOException ex) {
            throw new PluginPackageInvalidException("manifest.json cannot be read", ex);
        }
        if (jsonManifest == null) {
            throw invalid("manifest.json is empty");
        }
        if (jsonManifest.permissions() == null) {
            throw invalid("manifest permissions are required");
        }
        if (jsonManifest.modes() == null) {
            throw invalid("manifest modes are required");
        }
        List<PluginMode> modes;
        try {
            modes = jsonManifest.modes() == null ? null : jsonManifest.modes().stream()
                    .map(PluginMode::valueOf)
                    .toList();
        } catch (IllegalArgumentException ex) {
            throw invalid("manifest contains an unsupported mode");
        }
        try {
            return new PluginManifest(
                    jsonManifest.id(),
                    jsonManifest.name(),
                    jsonManifest.version(),
                    jsonManifest.description(),
                    jsonManifest.author(),
                    jsonManifest.entry(),
                    jsonManifest.permissions(),
                    modes);
        } catch (IllegalArgumentException ex) {
            // The domain message names the field but never echoes user content.
            throw new PluginPackageInvalidException(ex.getMessage(), ex);
        }
    }

    private static PluginPackageInvalidException invalid(String message) {
        return new PluginPackageInvalidException(message);
    }

    /** Jackson shape of manifest v1. Unknown keys are rejected by the mapper. */
    private record ManifestJson(
            String id,
            String name,
            String version,
            String description,
            String author,
            String entry,
            List<String> permissions,
            List<String> modes) {
    }
}
