package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** Response DTO for {@code GET /workspaces/{id}/dlp/policies}. */
public record DlpPolicyListResponse(List<DlpPolicyResponse> items) {
}
