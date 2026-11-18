package ru.krug.backend.ops.application.service;

import ru.krug.backend.ops.application.model.SmtpSettingsView;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.ops.domain.model.SystemSettings;

/** Domain settings -> secret-free read model. Never maps the password ciphertext. */
public final class SystemSettingsMapper {

    private SystemSettingsMapper() {
    }

    public static SystemSettingsView toView(SystemSettings settings) {
        SmtpSettingsView smtp = new SmtpSettingsView(settings.smtp().host(),
                settings.smtp().port(), settings.smtp().username(), settings.smtp().from(),
                settings.smtp().starttls(), settings.smtpConfigured());
        return new SystemSettingsView(settings.setupCompletedAt(), smtp,
                settings.maxChatsPerUser(), settings.maxChatsPerWorkspace(),
                settings.maxWorkspaceMembers(), settings.registrationOpen(),
                settings.updatedAt(), settings.updatedBy());
    }
}
