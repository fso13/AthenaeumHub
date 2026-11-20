package ru.krug.backend.workspace.application.port;

import java.util.UUID;

/**
 * Cross-context validation of a workspace logo (#82 / #92). Implemented by the file context.
 *
 * <p>The attachment must be an image that passed the AV gate. It is accepted when it belongs
 * to the same workspace, or, for the trusted direct-image pipeline only, when it is a
 * {@code source=DIRECT_IMAGE} attachment owned by the caller (the image may have been stored
 * in another workspace the caller belongs to). A guessed id from another workspace, and every
 * regular {@code UPLOAD} attachment from another workspace, is a hidden 404. Authorization
 * for the workspace itself ({@code manage_workspace}) is enforced by the caller before this
 * port is used.
 */
public interface WorkspaceLogoPort {

    UUID requireLogo(UUID workspaceId, UUID userId, UUID attachmentId);
}
