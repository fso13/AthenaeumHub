package ru.krug.backend.chat.api.dto;

import java.util.List;
import java.util.UUID;

public record ChatMemberIdsResponse(List<UUID> userIds) {
}
