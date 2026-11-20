package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.file.application.command.UploadImageCommand;
import ru.krug.backend.file.application.model.ImageUploadView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.usecase.DirectImageUploadHandler;
import ru.krug.backend.file.application.usecase.FileAccessGuard;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentSource;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.support.TestImages;
import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;

/** #92: authorization order, Keycloak default-workspace binding and fail-before-I/O rules. */
class DirectImageUploadHandlerTest {

    private static final UUID USER = UUID.randomUUID();
    private static final UUID DEVICE = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();

    private final AttachmentRepository attachments = mock(AttachmentRepository.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final AuditPort audit = mock(AuditPort.class);
    private final TenantContext tenantContext = mock(TenantContext.class);
    private final FileAccessGuard accessGuard = mock(FileAccessGuard.class);
    private final WorkspaceDirectoryPort workspaceDirectory = mock(WorkspaceDirectoryPort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private DirectImageUploadHandler handler;
    private Principal principal;

    @BeforeEach
    void setUp() {
        handler = new DirectImageUploadHandler(attachments, storage, audit, tenantContext,
                accessGuard, workspaceDirectory, clock);
        principal = new Principal(USER, DEVICE, null, "req-92");
        when(clock.now()).thenReturn(Instant.parse("2026-11-20T10:00:00Z"));
    }

    @Test
    void keycloakPrincipalWithoutWorkspaceClaimUsesFirstActiveWorkspace() {
        when(workspaceDirectory.listActiveMemberships(USER)).thenReturn(List.of(
                new WorkspaceMembershipView(WORKSPACE, "W", "w", "MEMBER", "MANAGED")));
        Principal scoped = principal.withWorkspace(WORKSPACE);
        when(accessGuard.requireWorkspaceAccess(principal, WORKSPACE)).thenReturn(scoped);

        ImageUploadView view = handler.upload(principal, new UploadImageCommand(null,
                "avatar.png", "image/png", TestImages.png(3, 2)));

        assertThat(view.width()).isEqualTo(3);
        assertThat(view.height()).isEqualTo(2);
        assertThat(view.mime()).isEqualTo("image/png");
        verify(tenantContext).activate(principal.withWorkspace(null));
        ArgumentCaptor<Attachment> saved = ArgumentCaptor.forClass(Attachment.class);
        verify(attachments).save(saved.capture());
        Attachment attachment = saved.getValue();
        assertThat(attachment.workspaceId()).isEqualTo(WORKSPACE);
        assertThat(attachment.chatId()).isNull();
        assertThat(attachment.uploadId()).isNull();
        assertThat(attachment.source()).isEqualTo(AttachmentSource.DIRECT_IMAGE);
        assertThat(attachment.scanStatus()).isEqualTo(ScanStatus.SKIPPED);
        assertThat(attachment.userId()).isEqualTo(USER);
        assertThat(attachment.objectKey())
                .startsWith("workspaces/" + WORKSPACE + "/images/");
        verify(storage).putObject(eq(attachment.objectKey()), any(), eq("image/png"));
        verify(audit).append(any());
    }

    @Test
    void chatBindingRequiresActiveChatAndRejectsE2eeBeforeStorage() {
        when(accessGuard.requireChat(principal, CHAT)).thenReturn(new ChatAccess(CHAT, WORKSPACE,
                "GROUP", "OWNER", "E2EE", 0));

        assertThatThrownBy(() -> handler.upload(principal, new UploadImageCommand(CHAT,
                "cover.png", "image/png", TestImages.png(2, 2))))
                .isInstanceOfSatisfying(DomainException.class,
                        error -> assertThat(error.code()).isEqualTo("E2EE_PLAINTEXT_FORBIDDEN"));

        verifyNoInteractions(attachments, storage, audit);
    }

    @Test
    void unsupportedMagicIsRejectedBeforeAnyAuthorizationOrStorage() {
        assertThatThrownBy(() -> handler.upload(principal, new UploadImageCommand(CHAT,
                "x.gif", "image/gif", TestImages.gif())))
                .isInstanceOfSatisfying(DomainException.class,
                        error -> assertThat(error.code()).isEqualTo("UNSUPPORTED_TYPE"));

        verifyNoInteractions(accessGuard, attachments, storage, audit);
    }

    @Test
    void oversizedBodyIsRejectedBeforeParsingOrAuthorization() {
        byte[] tooLarge = new byte[(int) DirectImageUploadHandler.MAX_IMAGE_BYTES + 1];
        assertThatThrownBy(() -> handler.upload(principal, new UploadImageCommand(null,
                "big.png", "image/png", tooLarge)))
                .isInstanceOfSatisfying(DomainException.class,
                        error -> assertThat(error.code()).isEqualTo("FILE_TOO_LARGE"));

        verifyNoInteractions(accessGuard, attachments, storage, audit, tenantContext);
    }
}
