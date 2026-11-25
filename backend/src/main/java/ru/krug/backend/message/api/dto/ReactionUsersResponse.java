package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

/** #201: users who reacted with one emoji, oldest first. */
public record ReactionUsersResponse(List<UUID> userIds) {
}
