package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.application.model.ChatKeysView;
import ru.krug.backend.auth.application.service.DeviceKeyEvents;
import ru.krug.backend.auth.application.usecase.ChatKeysService;
import ru.krug.backend.auth.domain.model.Device;
import ru.krug.backend.auth.domain.repository.DevicePrekeyRepository;
import ru.krug.backend.auth.domain.repository.DeviceRepository;
import ru.krug.backend.auth.domain.repository.KeyVerificationRepository;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * E2EE-REVIEW-07 P2-07: {@code ChatKeysService} must not trust {@code principal.deviceId}
 * on its own. The filter is the primary boundary; this is the defense-in-depth guard that
 * survives a future path/device-binding regression.
 */
class ChatKeysServiceDeviceGuardTest {

    private final TenantContext tenantContext = mock(TenantContext.class);
    private final ChatWorkspacePort chatWorkspace = mock(ChatWorkspacePort.class);
    private final ChatAccessPort chatAccess = mock(ChatAccessPort.class);
    private final ChatMemberDirectoryPort chatDirectory = mock(ChatMemberDirectoryPort.class);
    private final DeviceRepository deviceRepository = mock(DeviceRepository.class);
    private final DevicePrekeyRepository prekeyRepository = mock(DevicePrekeyRepository.class);
    private final KeyVerificationRepository verificationRepository =
            mock(KeyVerificationRepository.class);
    private final IdempotencyPort idempotency = mock(IdempotencyPort.class);
    private final RequestCanonicalizer canonicalizer = mock(RequestCanonicalizer.class);
    private final DeviceKeyEvents keyEvents = mock(DeviceKeyEvents.class);
    private final ClockPort clock = mock(ClockPort.class);

    private final ChatKeysService service = new ChatKeysService(tenantContext, chatWorkspace,
            chatAccess, chatDirectory, deviceRepository, prekeyRepository,
            verificationRepository, idempotency, canonicalizer, keyEvents, clock);

    private final UUID workspaceId = UUID.randomUUID();
    private final UUID chatId = UUID.randomUUID();
    private final UUID aliceId = UUID.randomUUID();
    private final UUID bobId = UUID.randomUUID();
    private final UUID aliceDeviceId = UUID.randomUUID();

    @BeforeEach
    void e2eeChat() {
        when(chatWorkspace.findWorkspaceForChat(chatId, aliceId))
                .thenReturn(Optional.of(workspaceId));
        when(chatAccess.requireActiveChat(workspaceId, chatId, aliceId))
                .thenReturn(new ChatAccess(chatId, workspaceId, "OWNER", "E2EE", 0));
        when(chatDirectory.find(workspaceId, chatId)).thenReturn(Optional.of(
                new ChatDirectorySnapshot(chatId, workspaceId, "chat", true,
                        List.of(aliceId, bobId))));
        when(clock.now()).thenReturn(Instant.now());
        when(verificationRepository.findByVerifierAndChat(any(), any())).thenReturn(List.of());
        when(prekeyRepository.findActiveSigned(any(), any())).thenReturn(Optional.empty());
    }

    @Test
    void activeOwnDevicePassesTheGuard() {
        Device device = Device.createWeb(aliceDeviceId, aliceId);
        when(deviceRepository.findById(aliceDeviceId)).thenReturn(Optional.of(device));
        when(deviceRepository.findActiveByUserIds(anyList())).thenReturn(List.of(device));

        ChatKeysView view = service.getChatKeys(principal(aliceDeviceId), chatId);

        assertThat(view.myDeviceId()).isEqualTo(aliceDeviceId);
        assertThat(view.verifierDeviceId()).isEqualTo(aliceDeviceId);
        assertThat(view.chatId()).isEqualTo(chatId);
    }

    @Test
    void activeDeviceOfAnotherUserIsForbidden() {
        UUID bobDeviceId = UUID.randomUUID();
        when(deviceRepository.findById(bobDeviceId))
                .thenReturn(Optional.of(Device.createWeb(bobDeviceId, bobId)));

        assertThatThrownBy(() -> service.getChatKeys(principal(bobDeviceId), chatId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("FORBIDDEN"));
    }

    @Test
    void revokedOwnDeviceIsForbidden() {
        Device revoked = Device.reconstitute(aliceDeviceId, aliceId, "old",
                Device.Platform.WEB, "0.7.0", Device.Status.REVOKED, Instant.now());
        when(deviceRepository.findById(aliceDeviceId)).thenReturn(Optional.of(revoked));

        assertThatThrownBy(() -> service.getChatKeys(principal(aliceDeviceId), chatId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("FORBIDDEN"));
    }

    @Test
    void unknownDeviceIsForbidden() {
        when(deviceRepository.findById(aliceDeviceId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getChatKeys(principal(aliceDeviceId), chatId))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("FORBIDDEN"));
    }

    @Test
    void verificationWriteAlsoRejectsAForeignDeviceBeforeAnyDatabaseWrite() {
        UUID bobDeviceId = UUID.randomUUID();
        when(deviceRepository.findById(bobDeviceId))
                .thenReturn(Optional.of(Device.createWeb(bobDeviceId, bobId)));

        assertThatThrownBy(() -> service.verifyDevice(principal(bobDeviceId), chatId,
                UUID.randomUUID(), new ChatKeysService.VerificationCommand(
                        UUID.randomUUID(), "MANUAL", 2, "ignored", 1)))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.category().name()).isEqualTo("FORBIDDEN"));
    }

    private Principal principal(UUID deviceId) {
        return new Principal(aliceId, deviceId, workspaceId, "unit-test");
    }
}
