package ru.krug.backend.message.api.dto;

import java.util.List;

public record MessagePageResponse(List<MessageResponse> items, MessagePageInfo page) {
}
