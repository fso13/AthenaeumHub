package ru.krug.backend.file.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.application.port.WorkerContext;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Shared file authz/tenant helper. Every file use case activates the transaction-local RLS
 * context before touching repositories; member/chat checks happen before business logic
 * (deny by default, 404 when existence must stay hidden).
 */
@Service
public class FileAccessGuard {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;
    private final WorkspaceAccessPort workspaceAccess;
    private final UploadRepository uploadRepository;
    private final AttachmentRepository attachmentRepository;
    private final WorkerContext workerContext;

    public FileAccessGuard(TenantContext tenantContext, ChatWorkspacePort chatWorkspace,
                           ChatAccessPort chatAccess, WorkspaceAccessPort workspaceAccess,
                           UploadRepository uploadRepository,
                           AttachmentRepository attachmentRepository,
                           WorkerContext workerContext) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
        this.workspaceAccess = workspaceAccess;
        this.uploadRepository = uploadRepository;
        this.attachmentRepository = attachmentRepository;
        this.workerContext = workerContext;
    }

    /** Binds a Keycloak principal (no workspace claim) to the chat's workspace. */
    public Principal scopeToChat(Principal principal, UUID chatId) {
        if (principal.workspaceId() != null) {
            return principal;
        }
        UUID workspaceId = chatWorkspace.workspaceForChat(chatId, principal.userId(),
                principal.requestId());
        return principal.withWorkspace(workspaceId);
    }

    /** Activates RLS and verifies active membership + chat access. */
    @Transactional(readOnly = true)
    public UUID requireChatAccess(Principal principal, UUID chatId) {
        Principal scoped = scopeToChat(principal, chatId);
        tenantContext.activate(scoped);
        chatAccess.requireActiveChat(scoped.workspaceId(), chatId, scoped.userId());
        return scoped.workspaceId();
    }

    /** Activates RLS and verifies workspace membership for a path workspace. */
    @Transactional(readOnly = true)
    public Principal requireWorkspaceAccess(Principal principal, UUID workspaceId) {
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        workspaceAccess.requireActiveMember(workspaceId, scoped.userId());
        return scoped;
    }

    public boolean isGuest(UUID workspaceId, UUID userId) {
        return workspaceAccess.isGuest(workspaceId, userId);
    }

    /**
     * Binds a Keycloak principal (no workspace claim) to the upload's workspace and activates
     * RLS. The SECURITY DEFINER resolver only returns the workspace for the uploader.
     */
    @Transactional
    public Principal activateUploadScope(Principal principal, UUID uploadId) {
        if (principal.workspaceId() != null) {
            tenantContext.activate(principal);
            return principal;
        }
        workerContext.activate(WorkerContext.WorkerRole.FILE_RESOLVE);
        Upload upload = uploadRepository.findByIdForResolve(uploadId)
                .orElseThrow(UploadNotFoundException::new);
        if (!upload.userId().equals(principal.userId())) {
            throw new UploadNotFoundException();
        }
        Principal scoped = principal.withWorkspace(upload.workspaceId());
        tenantContext.activate(scoped);
        return scoped;
    }

    @Transactional
    public Principal activateAttachmentScope(Principal principal, UUID attachmentId) {
        if (principal.workspaceId() != null) {
            tenantContext.activate(principal);
            return principal;
        }
        workerContext.activate(WorkerContext.WorkerRole.FILE_RESOLVE);
        Attachment attachment = attachmentRepository.findByIdForResolve(attachmentId)
                .orElseThrow(UploadNotFoundException::new);
        Principal scoped = principal.withWorkspace(attachment.workspaceId());
        if (attachment.isOwnedBy(principal.userId())) {
            tenantContext.activate(scoped);
            return scoped;
        }
        if (attachment.messageId() == null) {
            // Unbound attachments are visible only to the uploader.
            throw new UploadNotFoundException();
        }
        tenantContext.activate(scoped);
        if (!workspaceAccess.isActiveMember(attachment.workspaceId(), principal.userId())) {
            throw new UploadNotFoundException();
        }
        return scoped;
    }
}
