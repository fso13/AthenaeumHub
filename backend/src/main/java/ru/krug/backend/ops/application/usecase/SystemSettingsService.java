package ru.krug.backend.ops.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.ops.application.port.SmtpPasswordCipherPort;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.ops.application.service.SystemSettingsMapper;
import ru.krug.backend.ops.domain.model.SystemSettings;
import ru.krug.backend.ops.domain.repository.SystemSettingsRepository;

/** Read side of the settings context, published to auth/chat through a port. */
@Service
public class SystemSettingsService implements SystemSettingsPort {

    private final SystemSettingsRepository repository;
    private final SmtpPasswordCipherPort cipher;

    public SystemSettingsService(SystemSettingsRepository repository,
                                 SmtpPasswordCipherPort cipher) {
        this.repository = repository;
        this.cipher = cipher;
    }

    @Override
    @Transactional(readOnly = true)
    public SystemSettingsView current() {
        return SystemSettingsMapper.toView(repository.load());
    }

    @Override
    @Transactional(readOnly = true)
    public RuntimeSmtpSettings smtp() {
        SystemSettings settings = repository.load();
        String password = settings.smtp().hasPassword()
                ? cipher.decrypt(settings.smtp().passwordCiphertext())
                : null;
        return new RuntimeSmtpSettings(settings.smtp().host(), settings.smtp().port(),
                settings.smtp().username(), password, settings.smtp().from(),
                settings.smtp().starttls());
    }
}
