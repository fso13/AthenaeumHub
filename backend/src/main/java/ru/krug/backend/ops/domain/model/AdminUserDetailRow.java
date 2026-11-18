package ru.krug.backend.ops.domain.model;

import java.util.UUID;

/**
 * One non-deleted user as seen by the platform-admin action pre-check. Metadata only:
 * no password, no Keycloak subject, no content.
 */
public record AdminUserDetailRow(
        UUID id,
        String email,
        String displayName,
        String status,
        boolean platformAdmin) {
}
