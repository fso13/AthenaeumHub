package ru.krug.backend.support;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream;

/** Builds safe and malicious plugin ZIPs for D1.2 integration/unit tests. */
public final class PluginPackageTestSupport {

    public static final String DEFAULT_MANIFEST = """
            {
              "id": "demo-panel",
              "name": "Demo panel",
              "version": "1.0.0",
              "description": "Static demo panel",
              "author": "Sova",
              "entry": "index.html",
              "permissions": ["chat.messages.read"],
              "modes": ["MANAGED"]
            }
            """;

    private PluginPackageTestSupport() {
    }

    public static String manifest(String id, String entry, String permissionsJson,
                                  String modesJson) {
        return """
                {
                  "id": "%s",
                  "name": "Demo panel",
                  "version": "1.2.3",
                  "description": "Static demo panel",
                  "author": "Sova",
                  "entry": "%s",
                  "permissions": %s,
                  "modes": %s
                }
                """.formatted(id, entry, permissionsJson, modesJson);
    }

    public static byte[] packageZip(String manifestId, String entry) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json", manifest(manifestId, entry,
                "[\"chat.messages.read\"]", "[\"MANAGED\"]").getBytes(StandardCharsets.UTF_8));
        entries.put(entry, "<!doctype html><html><body>demo</body></html>"
                .getBytes(StandardCharsets.UTF_8));
        entries.put("assets/app.js", "console.log('demo')".getBytes(StandardCharsets.UTF_8));
        entries.put("assets/logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
                .getBytes(StandardCharsets.UTF_8));
        return zip(entries);
    }

    public static byte[] zipWithDuplicate(String manifestJson) {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipArchiveOutputStream zip = new ZipArchiveOutputStream(output)) {
                zip.setEncoding(StandardCharsets.UTF_8.name());
                for (int i = 0; i < 2; i++) {
                    ZipArchiveEntry entry = new ZipArchiveEntry("dup.txt");
                    zip.putArchiveEntry(entry);
                    zip.write(("content " + i).getBytes(StandardCharsets.UTF_8));
                    zip.closeArchiveEntry();
                }
                ZipArchiveEntry manifest = new ZipArchiveEntry("manifest.json");
                zip.putArchiveEntry(manifest);
                zip.write(manifestJson.getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();
                ZipArchiveEntry html = new ZipArchiveEntry("index.html");
                zip.putArchiveEntry(html);
                zip.write("<html/>".getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();
            }
            return output.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot build duplicate zip", ex);
        }
    }

    public static byte[] zipWithText(String manifestJson, String entry,
                                     Map<String, String> extra) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json", manifestJson.getBytes(StandardCharsets.UTF_8));
        entries.put(entry, "<html>ok</html>".getBytes(StandardCharsets.UTF_8));
        extra.forEach((name, value) ->
                entries.put(name, value.getBytes(StandardCharsets.UTF_8)));
        return zip(entries);
    }

    public static byte[] zip(Map<String, byte[]> entries) {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipArchiveOutputStream zip = new ZipArchiveOutputStream(output)) {
                zip.setEncoding(StandardCharsets.UTF_8.name());
                for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                    ZipArchiveEntry archiveEntry = new ZipArchiveEntry(entry.getKey());
                    zip.putArchiveEntry(archiveEntry);
                    zip.write(entry.getValue());
                    zip.closeArchiveEntry();
                }
            }
            return output.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot build test zip", ex);
        }
    }

    public static byte[] zipWithSymlink(String manifestJson, String entry) {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipArchiveOutputStream zip = new ZipArchiveOutputStream(output)) {
                zip.setEncoding(StandardCharsets.UTF_8.name());
                ZipArchiveEntry manifest = new ZipArchiveEntry("manifest.json");
                zip.putArchiveEntry(manifest);
                zip.write(manifestJson.getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();

                ZipArchiveEntry html = new ZipArchiveEntry(entry);
                zip.putArchiveEntry(html);
                zip.write("<html>ok</html>".getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();

                ZipArchiveEntry symlink = new ZipArchiveEntry("assets/link");
                symlink.setUnixMode(0120777);
                zip.putArchiveEntry(symlink);
                zip.write("index.html".getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();
            }
            return output.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot build symlink zip", ex);
        }
    }

    public static byte[] zipBomb(String manifestJson, String entry) {
        byte[] manifest = manifestJson.getBytes(StandardCharsets.UTF_8);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipArchiveOutputStream zip = new ZipArchiveOutputStream(output)) {
                zip.setEncoding(StandardCharsets.UTF_8.name());
                ZipArchiveEntry manifestEntry = new ZipArchiveEntry("manifest.json");
                zip.putArchiveEntry(manifestEntry);
                zip.write(manifest);
                zip.closeArchiveEntry();

                ZipArchiveEntry html = new ZipArchiveEntry(entry);
                zip.putArchiveEntry(html);
                zip.write("<html>ok</html>".getBytes(StandardCharsets.UTF_8));
                zip.closeArchiveEntry();

                ZipArchiveEntry bomb = new ZipArchiveEntry("assets/bomb.bin");
                zip.putArchiveEntry(bomb);
                byte[] zeros = new byte[64 * 1024];
                for (int i = 0; i < 11 * 16; i++) {
                    zip.write(zeros);
                }
                zip.closeArchiveEntry();
            }
            return output.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot build bomb zip", ex);
        }
    }

    public static byte[] manyFiles(String manifestJson, String entry, int count) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json", manifestJson.getBytes(StandardCharsets.UTF_8));
        entries.put(entry, "<html>ok</html>".getBytes(StandardCharsets.UTF_8));
        for (int i = 0; i < count; i++) {
            entries.put("assets/f" + i + ".txt", ("file " + i).getBytes(StandardCharsets.UTF_8));
        }
        return zip(entries);
    }
}
