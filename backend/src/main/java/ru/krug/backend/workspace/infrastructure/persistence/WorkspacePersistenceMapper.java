package ru.krug.backend.workspace.infrastructure.persistence;

import ru.krug.backend.workspace.domain.model.Workspace;

public final class WorkspacePersistenceMapper {

    private WorkspacePersistenceMapper() {
    }

    public static Workspace toDomain(WorkspaceEntity entity) {
        return Workspace.reconstitute(entity.getId(), entity.getName(), entity.getSlug(),
                entity.getDescription(), entity.getLogoFileId(),
                Workspace.SecurityMode.valueOf(entity.getSecurityMode()),
                Workspace.Status.valueOf(entity.getStatus()), entity.getCreatedBy());
    }
}
