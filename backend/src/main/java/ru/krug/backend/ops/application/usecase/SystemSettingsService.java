package ru.krug.backend.ops.application.usecase;

import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.ops.application.port.SmtpPasswordCipherPort;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.ops.application.service.SystemSettingsMapper;
import ru.krug.backend.ops.domain.model.SystemSettings;
import ru.krug.backend.ops.domain.repository.SystemSettingsRepository;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

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

    /**
     * Hot path for upload init/preflight. The value is cached by the settings PATCH
     * ({@code UpdateAdminSettingsService} evicts after a successful commit), so an admin
     * change applies to the next upload without a restart. The cache is local to the node;
     * in a clustered deployment other nodes refresh on their own next PATCH/deploy, which
     * is documented in the file-types report.
     */
    @Override
    @Transactional(readOnly = true)
    @Cacheable(cacheNames = SystemSettingsPort.ALLOWED_FILE_EXTENSIONS_CACHE,
            key = "'singleton'")
    public AllowedFileExtensions allowedFileExtensions() {
        return repository.load().allowedFileExtensions();
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
