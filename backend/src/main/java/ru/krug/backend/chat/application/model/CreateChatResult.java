package ru.krug.backend.chat.application.model;

public record CreateChatResult(int status, ChatView chat, boolean existing) {
}
