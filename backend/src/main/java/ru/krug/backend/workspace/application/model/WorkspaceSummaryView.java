package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Application result for onboarding. The role is always OWNER for the creator. */
public record WorkspaceSummaryView(
        UUID id,
        String name,
        String slug,
        String role,
        String securityMode) {
}
