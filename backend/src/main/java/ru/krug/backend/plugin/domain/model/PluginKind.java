package ru.krug.backend.plugin.domain.model;

/**
 * Origin of a plugin catalog row. {@code BUILTIN} rows are first-party and seeded by
 * migrations; {@code EXTERNAL} rows are admin-installed static packages. Neither kind may
 * execute server-side code.
 */
public enum PluginKind {
    BUILTIN, EXTERNAL
}
