package ru.krug.backend.chat.application.command;

/** {@code PATCH /chats/{chatId}} (D1-BE3). Null means "field not provided". */
public record ChatUpdateCommand(String name, String description) {

    public boolean isEmpty() {
        return name == null && description == null;
    }
}
