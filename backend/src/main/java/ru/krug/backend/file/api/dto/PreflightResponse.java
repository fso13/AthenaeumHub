package ru.krug.backend.file.api.dto;

import java.util.List;

public record PreflightResponse(
        String decision,
        long maxFileBytes,
        int maxAttachments,
        PreflightQuotaResponse quota,
        List<PreflightDecisionResponse> files) {
}
