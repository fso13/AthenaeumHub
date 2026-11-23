package ru.krug.backend.ops.application.model;

/** Counters for one scheduled workspace-retention run (#101). Never contains content. */
public record WorkspaceRetentionReport(int workspaces, int messages, int files, int batches,
                                       int failedWorkspaces) {
}
