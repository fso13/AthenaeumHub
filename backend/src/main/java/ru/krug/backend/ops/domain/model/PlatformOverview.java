package ru.krug.backend.ops.domain.model;

/** Platform-wide aggregate counts for the admin overview (no row-level data, no E2EE content). */
public record PlatformOverview(long users, long workspaces, long chats) {
}
