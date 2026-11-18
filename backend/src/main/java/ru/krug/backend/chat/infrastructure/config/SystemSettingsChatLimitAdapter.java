package ru.krug.backend.chat.infrastructure.config;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatLimitSettingsPort;
import ru.krug.backend.ops.application.port.SystemSettingsPort;

/** Reads the installation chat limits from the ops settings singleton. */
@Component
public class SystemSettingsChatLimitAdapter implements ChatLimitSettingsPort {

    private final SystemSettingsPort settings;

    public SystemSettingsChatLimitAdapter(SystemSettingsPort settings) {
        this.settings = settings;
    }

    @Override
    public int maxChatsPerUser() {
        return settings.current().maxChatsPerUser();
    }

    @Override
    public int maxChatsPerWorkspace() {
        return settings.current().maxChatsPerWorkspace();
    }
}
