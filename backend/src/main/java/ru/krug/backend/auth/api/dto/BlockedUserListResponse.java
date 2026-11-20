package ru.krug.backend.auth.api.dto;

import java.util.List;

/** OpenAPI {@code BlockedUserList} (#79). */
public record BlockedUserListResponse(List<BlockedUserResponse> items) {
}
