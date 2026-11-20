package ru.krug.backend.workspace.application.port;

import java.util.UUID;

/**
 * Cross-context validation of a workspace logo (P0-4 / #82). Implemented by the file
 * context. The attachment must belong to the same workspace, be an image and pass the AV
 * gate. A guessed id from another workspace is a hidden 404.
 */
public interface WorkspaceLogoPort {

    UUID requireLogo(UUID workspaceId, UUID attachmentId);
}
