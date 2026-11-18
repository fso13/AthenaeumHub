package ru.krug.backend.ops.api.dto;

import java.util.List;

/** Response DTO for {@code GET /admin/storage} (contract {@code AdminStorage}). */
public record AdminStorageResponse(
        AdminStorageTotalsResponse totals,
        List<AdminStorageWorkspaceResponse> workspaces) {
}
