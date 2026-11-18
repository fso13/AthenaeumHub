package ru.krug.backend.chat.application.port;

import ru.krug.backend.chat.application.command.DefaultChatCommand;
import ru.krug.backend.chat.application.command.DevChatCommand;

public interface ChatProvisioningPort {

    void ensureDevGroupChat(DevChatCommand command);

    /**
     * Creates the default «Общий чат» group for a freshly onboarded workspace. Idempotent
     * by chat id; the caller supplies the id so a retry targets the same row.
     */
    void createDefaultGroupChat(DefaultChatCommand command);
}
