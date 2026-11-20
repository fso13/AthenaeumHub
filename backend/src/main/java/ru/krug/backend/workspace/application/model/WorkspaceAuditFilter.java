package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/** Exact workspace audit filters shared by the page and the bounded export. */
public record WorkspaceAuditFilter(String action, UUID actorId, Instant from, Instant to) {
}
