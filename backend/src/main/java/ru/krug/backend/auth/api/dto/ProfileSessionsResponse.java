package ru.krug.backend.auth.api.dto;

import java.util.List;

/** {@code GET /me/sessions}. Ordered by last access, most recent first. */
public record ProfileSessionsResponse(List<ProfileSessionResponse> sessions) {
}
