package ru.krug.backend.chat.api.dto;

import java.util.List;

public record ChatListResponse(List<ChatSummaryResponse> items) {
}
