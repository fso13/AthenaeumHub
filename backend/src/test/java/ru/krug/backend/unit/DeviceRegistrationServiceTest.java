package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.command.RegisterDeviceCommand;
import ru.krug.backend.auth.application.model.DeviceView;
import ru.krug.backend.auth.application.usecase.DeviceRegistrationService;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

class DeviceRegistrationServiceTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final Principal PRINCIPAL = new Principal(USER_ID, null, null, "req");
    private static final RegisterDeviceCommand COMMAND = new RegisterDeviceCommand("Chrome",
            "WEB", "1.0.0");

    @Test
    void registersActiveWebDevice() {
        DeviceRepository repository = mock(DeviceRepository.class);
        when(repository.findActiveByNaturalKey(USER_ID, "Chrome", "WEB", "1.0.0"))
                .thenReturn(Optional.empty());
        when(repository.countActive(USER_ID)).thenReturn(0L);
        DeviceRegistrationService service = new DeviceRegistrationService(
                mock(TenantContext.class), repository, () -> Instant.parse("2026-01-01T00:00:00Z"));

        DeviceView view = service.register(PRINCIPAL, COMMAND);

        assertThat(view.platform()).isEqualTo("WEB");
        assertThat(view.createdAt()).isNotNull();
        verify(repository).lockOwner(USER_ID);
        verify(repository).save(any(Device.class));
    }

    @Test
    void returnsExistingDeviceForSameNaturalKeyInsteadOfFailingAtLimit() {
        DeviceRepository repository = mock(DeviceRepository.class);
        UUID id = UUID.randomUUID();
        Device existing = Device.reconstitute(id, USER_ID, "Chrome", Device.Platform.WEB,
                "1.0.0", Device.Status.ACTIVE, Instant.parse("2025-01-01T00:00:00Z"));
        when(repository.findActiveByNaturalKey(USER_ID, "Chrome", "WEB", "1.0.0"))
                .thenReturn(Optional.of(existing));
        DeviceRegistrationService service = new DeviceRegistrationService(
                mock(TenantContext.class), repository, Instant::now);

        DeviceView view = service.register(PRINCIPAL, COMMAND);

        assertThat(view.id()).isEqualTo(id);
        verify(repository, never()).save(any());
        verify(repository, never()).countActive(any());
    }

    @Test
    void rejectsSixthActiveDevice() {
        DeviceRepository repository = mock(DeviceRepository.class);
        when(repository.findActiveByNaturalKey(any(), anyString(), anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(repository.countActive(USER_ID)).thenReturn(5L);
        DeviceRegistrationService service = new DeviceRegistrationService(
                mock(TenantContext.class), repository, Instant::now);

        assertThatThrownBy(() -> service.register(PRINCIPAL, COMMAND))
                .isInstanceOf(DomainException.class)
                .extracting(ex -> ((DomainException) ex).code())
                .isEqualTo(ErrorCode.DEVICE_LIMIT_REACHED);
        verify(repository, never()).save(any());
    }

    @Test
    void rejectsNonWebPlatformBeforeTouchingTheDatabase() {
        DeviceRepository repository = mock(DeviceRepository.class);
        DeviceRegistrationService service = new DeviceRegistrationService(
                mock(TenantContext.class), repository, Instant::now);

        assertThatThrownBy(() -> service.register(PRINCIPAL,
                new RegisterDeviceCommand("Chrome", "MOBILE", "1.0")))
                .isInstanceOf(DomainException.class);
        verify(repository, never()).lockOwner(any());
    }
}
