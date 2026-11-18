package ru.krug.backend.file.application.model;

import java.util.List;

public record PreflightView(
        String decision,
        long maxFileBytes,
        int maxAttachments,
        QuotaView quota,
        List<PreflightFileView> files) {
}
