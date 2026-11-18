package ru.krug.backend.ops.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.domain.model.AdminChatDeleteResult;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code DELETE /admin/chats/{chatId}} (FR-ADM-16): soft-delete only.
 *
 * <p>The V25 function sets {@code chats.deleted_at}; chat_members, messages and files are
 * kept. Every read path already filters {@code deleted_at IS NULL}, so the chat disappears
 * for participants and from the admin directory without a destructive delete. A repeated
 * delete is a documented {@code 409 CHAT_ALREADY_DELETED} (not a silent no-op), so the UI
 * can distinguish retries from a successful action.</p>
 *
 * <p>The audit event records the chat id, its workspace id and the member count — IDs and
 * counts only, never the chat name or message text. It is appended in the admin's own
 * hash-chain scope (workspace_id = null) and does not touch the tenant chain.</p>
 */
@Service
public class SoftDeleteChatService {

    static final String ACTION = "admin.chat.deleted";

    private final PlatformAdminGuard adminGuard;
    private final AdminActionRepository actions;
    private final AuditPort audit;
    private final ClockPort clock;

    public SoftDeleteChatService(PlatformAdminGuard adminGuard,
                                 AdminActionRepository actions,
                                 AuditPort audit,
                                 ClockPort clock) {
        this.adminGuard = adminGuard;
        this.actions = actions;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void delete(Principal principal, UUID chatId) {
        adminGuard.require(principal);
        AdminChatDeleteResult result = actions.softDeleteChat(chatId);
        switch (result.outcome()) {
            case NOT_FOUND -> throw DomainException.notFound("Chat not found");
            case ALREADY_DELETED -> throw DomainException.conflict(
                    ErrorCode.CHAT_ALREADY_DELETED, "Chat is already deleted",
                    Map.of("field", "chat_id"));
            case OK -> {
                // Continue: deleted_at is set inside this transaction.
            }
        }

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "chat", chatId,
                principal.requestId(),
                Map.of("workspace_id", result.workspaceId() == null
                                ? "" : result.workspaceId().toString(),
                        "members", result.membersCount()), clock.now()));
    }
}
