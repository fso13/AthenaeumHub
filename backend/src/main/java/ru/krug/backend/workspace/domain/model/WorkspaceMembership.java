package ru.krug.backend.workspace.domain.model;

import java.util.Objects;

/**
 * Read model inside the workspace aggregate boundary: a workspace together with the
 * caller's membership. Kept in domain so application code never joins tables itself.
 */
public record WorkspaceMembership(Workspace workspace, Membership membership) {

    public WorkspaceMembership {
        Objects.requireNonNull(workspace, "workspace");
        Objects.requireNonNull(membership, "membership");
    }
}
