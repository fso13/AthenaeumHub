package ru.krug.backend.plugin.domain.model;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validated manifest v1 of an external plugin package. It is metadata only: the backend
 * never loads, executes or interprets plugin code.
 *
 * <pre>{@code
 * {
 *   "id": "hello-panel",
 *   "name": "Hello panel",
 *   "version": "1.0.0",
 *   "description": "Example static panel",
 *   "author": "Sova",
 *   "entry": "index.html",
 *   "permissions": ["chat.messages.read"],
 *   "modes": ["MANAGED"]
 * }
 * }</pre>
 */
public record PluginManifest(
        String id,
        String name,
        String version,
        String description,
        String author,
        String entry,
        List<String> permissions,
        List<PluginMode> modes) {

    public static final int NAME_MAX = 120;
    public static final int DESCRIPTION_MAX = 500;
    public static final int AUTHOR_MAX = 120;
    public static final int MAX_PERMISSIONS = 16;

    /** Closed permission vocabulary of manifest v1. */
    public static final Set<String> MANIFEST_PERMISSIONS = Set.of(
            "chat.messages.read",
            "chat.messages.write",
            "chat.members.read",
            "chat.files.read",
            "chat.files.write",
            "webhooks.send");

    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]{0,63}");
    private static final Pattern VERSION = Pattern.compile(
            "^(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})"
                    + "([-+][A-Za-z0-9.-]{1,32})?$");

    public PluginManifest {
        id = requireText(id, "id", 64, false);
        if (!ID.matcher(id).matches()) {
            throw invalid("id must be a lowercase slug");
        }
        name = requireText(name, "name", NAME_MAX, true);
        version = requireText(version, "version", 32, false);
        if (!VERSION.matcher(version).matches()) {
            throw invalid("version must be semantic version MAJOR.MINOR.PATCH");
        }
        description = requireText(description, "description", DESCRIPTION_MAX, true);
        author = requireText(author, "author", AUTHOR_MAX, true);
        entry = PluginPaths.requireEntry(entry);

        Objects.requireNonNull(permissions, "permissions");
        Objects.requireNonNull(modes, "modes");
        if (permissions.size() > MAX_PERMISSIONS) {
            throw invalid("permissions contains too many entries");
        }
        Set<String> uniquePermissions = new LinkedHashSet<>();
        for (String permission : permissions) {
            if (permission == null || !MANIFEST_PERMISSIONS.contains(permission)) {
                throw invalid("permissions contains an unsupported token");
            }
            if (!uniquePermissions.add(permission)) {
                throw invalid("permissions contains a duplicate token");
            }
        }
        if (modes.isEmpty()) {
            throw invalid("modes must contain at least one mode");
        }
        Set<PluginMode> uniqueModes = new LinkedHashSet<>();
        for (PluginMode mode : modes) {
            if (mode == null) {
                throw invalid("modes contains a null entry");
            }
            if (!uniqueModes.add(mode)) {
                throw invalid("modes contains a duplicate mode");
            }
        }
        permissions = List.copyOf(uniquePermissions);
        modes = List.copyOf(uniqueModes);
    }

    private static String requireText(String raw, String field, int maxLength,
                                      boolean rejectMarkup) {
        if (raw == null) {
            throw invalid(field + " is required");
        }
        String value = raw.strip();
        if (value.isEmpty() || value.length() > maxLength) {
            throw invalid(field + " must be 1.." + maxLength + " characters");
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c)) {
                throw invalid(field + " contains a control character");
            }
            if (rejectMarkup && (c == '<' || c == '>')) {
                throw invalid(field + " must be plain text without markup");
            }
            if (Character.isSurrogate(c)) {
                if (Character.isHighSurrogate(c) && i + 1 < value.length()
                        && Character.isLowSurrogate(value.charAt(i + 1))) {
                    i++;
                } else {
                    throw invalid(field + " contains an invalid character");
                }
            }
        }
        return value;
    }

    private static IllegalArgumentException invalid(String reason) {
        return new IllegalArgumentException("invalid manifest: " + reason);
    }
}
