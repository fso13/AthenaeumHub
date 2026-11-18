package ru.krug.backend.chat.application.port;

/** Installation chat limits published by the ops settings context. */
public interface ChatLimitSettingsPort {

    int maxChatsPerUser();

    int maxChatsPerWorkspace();
}
