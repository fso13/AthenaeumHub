package ru.krug.backend.plugin.domain.model;

/**
 * Closed capability vocabulary shown to the user. In this slice permissions are
 * descriptive only: there is no plugin runtime, capability token or RPC broker yet.
 */
public enum PluginPermission {
    MESSAGES, MEMBERS, FILES, WEBHOOKS
}
