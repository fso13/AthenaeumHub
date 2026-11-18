package ru.krug.backend.chat.application.model;

import java.util.List;

public record ChatListView(List<ChatSummaryView> items) {
}
