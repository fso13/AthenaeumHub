package ru.krug.backend.plugin.domain.model;

/**
 * Security contour a plugin can run in. {@code MANAGED} plugins may use server-side data;
 * {@code E2EE} plugins are client-only and must never receive server-readable plaintext.
 */
public enum PluginMode {
    MANAGED, E2EE
}
