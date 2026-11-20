package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.file.application.model.DownloadUrlView;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.usecase.AttachmentDownloadHandler;
import ru.krug.backend.file.application.usecase.FileAccessGuard;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.MediaMetadataSource;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * #92: direct-image visibility. A chat-bound direct image is a channel asset readable by
 * active participants; an unbound one (cover/logo) is readable by active workspace members.
 * A regular unbound upload stays owner-only.
 */
class AttachmentDownloadHandlerTest {

    private static final UUID USER = UUID.randomUUID();
    private static final UUID OTHER = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID ATTACHMENT = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-20T10:00:00Z");

    private final TenantContext tenantContext = mock(TenantContext.class);
    private final FileAccessGuard accessGuard = mock(FileAccessGuard.class);
    private final AttachmentRepository attachments = mock(AttachmentRepository.class);
    private final ChatAccessPort chatAccess = mock(ChatAccessPort.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final FileSettingsPort settings = mock(FileSettingsPort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private AttachmentDownloadHandler handler;
    private Principal principal;
    private Principal scoped;

    @BeforeEach
    void setUp() {
        handler = new AttachmentDownloadHandler(tenantContext, accessGuard, attachments,
                chatAccess, storage, settings, clock);
        principal = new Principal(OTHER, UUID.randomUUID(), null, "req-92");
        scoped = principal.withWorkspace(WORKSPACE);
        when(accessGuard.activateAttachmentScope(principal, ATTACHMENT)).thenReturn(scoped);
        when(settings.downloadTtl()).thenReturn(Duration.ofMinutes(5));
        when(clock.now()).thenReturn(NOW);
        when(storage.presignGet(any(), any(), any(), any())).thenReturn(
                new ObjectStoragePort.PresignedUrl("memory://krug/key", NOW.plusSeconds(300)));
    }

    @Test
    void chatBoundDirectImageIsReadableByAnActiveParticipant() {
        Attachment attachment = directImage(CHAT);
        when(attachments.findById(WORKSPACE, ATTACHMENT)).thenReturn(Optional.of(attachment));

        DownloadUrlView view = handler.downloadUrl(principal, ATTACHMENT);

        assertThat(view.url()).isEqualTo("memory://krug/key");
        verify(chatAccess).requireActiveChat(WORKSPACE, CHAT, OTHER);
        verify(accessGuard, never()).requireWorkspaceAccess(any(), any());
    }

    @Test
    void unboundDirectImageIsReadableByAnActiveWorkspaceMember() {
        Attachment attachment = directImage(null);
        when(attachments.findById(WORKSPACE, ATTACHMENT)).thenReturn(Optional.of(attachment));

        DownloadUrlView view = handler.downloadUrl(principal, ATTACHMENT);

        assertThat(view.url()).isEqualTo("memory://krug/key");
        verify(accessGuard).requireWorkspaceAccess(scoped, WORKSPACE);
        verify(chatAccess, never()).requireActiveChat(any(), any(), any());
    }

    @Test
    void regularUnboundUploadIsStillOwnerOnly() {
        Attachment attachment = Attachment.uploaded(ATTACHMENT, WORKSPACE, CHAT,
                UUID.randomUUID(), USER, "x.png", "image/png", 4, Sha256.of("a".repeat(64)),
                "workspaces/w/files/u", NOW);
        when(attachments.findById(WORKSPACE, ATTACHMENT)).thenReturn(Optional.of(attachment));

        assertThatThrownBy(() -> handler.downloadUrl(principal, ATTACHMENT))
                .isInstanceOf(UploadNotFoundException.class);
        verify(storage, never()).presignGet(any(), any(), any(), any());
    }

    @Test
    void chatBoundDirectImageRejectsANonParticipant() {
        Attachment attachment = directImage(CHAT);
        when(attachments.findById(WORKSPACE, ATTACHMENT)).thenReturn(Optional.of(attachment));
        org.mockito.Mockito.doThrow(DomainException.notFound("Chat not found"))
                .when(chatAccess).requireActiveChat(WORKSPACE, CHAT, OTHER);

        assertThatThrownBy(() -> handler.downloadUrl(principal, ATTACHMENT))
                .isInstanceOf(DomainException.class);
        verify(storage, never()).presignGet(any(), any(), any(), any());
    }

    private static Attachment directImage(UUID chatId) {
        MediaMetadata media = new MediaMetadata(MediaKind.IMAGE, null, 2, 2, null, null, null,
                null, null, null, MediaMetadataSource.SERVER);
        return Attachment.directImage(ATTACHMENT, WORKSPACE, chatId, USER, "avatar.png",
                "image/png", media, 8, Sha256.of("b".repeat(64)),
                "workspaces/w/images/a", NOW);
    }
}
