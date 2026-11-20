package ru.krug.backend.workspace.application.model;

import java.util.Objects;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;

/** Authenticated caller's active workspace + membership, resolved under tenant RLS. */
public record WorkspaceAccessContext(Workspace workspace, Membership membership) {

    public WorkspaceAccessContext {
        Objects.requireNonNull(workspace, "workspace");
        Objects.requireNonNull(membership, "membership");
    }

    public Membership.Role role() {
        return membership.role();
    }
}
