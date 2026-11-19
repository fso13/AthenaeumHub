package ru.krug.backend.plugin.domain.model;

/**
 * Catalog lifecycle state. {@code DISABLED} is a product kill switch: the row remains
 * visible (so clients can explain why) but it can never be enabled in a chat.
 */
public enum PluginState {
    ACTIVE, DISABLED
}
