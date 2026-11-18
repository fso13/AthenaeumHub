package ru.krug.backend.file.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatUsageView;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.file.application.model.QuotaView;
import ru.krug.backend.file.application.model.WorkspaceLimitsView;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.shared.application.model.Principal;

/**
 * GET /workspaces/{id}/limits. Membership is checked before any limit/usage is read. The
 * response extends the E4 file limits with the E8 chat counters (server is the source of
 * truth for the create-chat dialog).
 */
@Service
public class WorkspaceLimitsHandler {

    private final FileAccessGuard accessGuard;
    private final WorkspaceQuotaPort quota;
    private final ChatUsagePort chatUsage;

    public WorkspaceLimitsHandler(FileAccessGuard accessGuard, WorkspaceQuotaPort quota,
                                  ChatUsagePort chatUsage) {
        this.accessGuard = accessGuard;
        this.quota = quota;
        this.chatUsage = chatUsage;
    }

    @Transactional
    public WorkspaceLimitsView limits(Principal principal, UUID workspaceId) {
        Principal scoped = accessGuard.requireWorkspaceAccess(principal, workspaceId);
        WorkspaceLimits limits = quota.limits(scoped.workspaceId());
        QuotaUsage usage = quota.usage(scoped.workspaceId());
        ChatUsageView chats = chatUsage.usage(scoped.workspaceId(), scoped.userId());
        return new WorkspaceLimitsView(limits.tariff().name(), limits.maxFileBytes(),
                limits.storageBytes(), limits.maxAttachments(), limits.guestFileBytes(),
                new QuotaView(usage.used(), usage.reserved(), limits.storageBytes()),
                chats.maxChatsPerUser(), chats.chatsUsedByUser());
    }
}
