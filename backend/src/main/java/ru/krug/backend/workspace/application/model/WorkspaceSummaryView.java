package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Application result for onboarding and workspace settings responses. */
public record WorkspaceSummaryView(
        UUID id,
        String name,
        String slug,
        String role,
        String securityMode,
        String description,
        UUID logoFileId) {

    public WorkspaceSummaryView(UUID id, String name, String slug, String role,
                                String securityMode) {
        this(id, name, slug, role, securityMode, null, null);
    }
}
