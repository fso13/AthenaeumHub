package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record CreateWorkspaceRequest(
        @NotBlank @Size(min = 1, max = 120) String name,
        @NotNull @Pattern(regexp = "MANAGED|E2EE",
                message = "must be MANAGED or E2EE") String securityMode) {
}
