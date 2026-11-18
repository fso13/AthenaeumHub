package ru.krug.backend.ops.application.model;

/** Aggregate admin overview. Counts only; no tenant, user or E2EE content is exposed. */
public record AdminOverviewView(long users, long workspaces, long chats) {
}
