package ru.krug.backend.message.application.service;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.message.application.model.EnvelopeCoverageView;
import ru.krug.backend.message.application.port.MessageChatContextPort;
import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * Recomputes E2EE coverage for an idempotent replay that is recovered outside the failed
 * send transaction (the {@code client_message_id} unique-index race).
 *
 * <p>E2EE-REVIEW-06 P2-02: the old code called {@code chatContext.require} after the send
 * transaction had rolled back, without activating {@code app.workspace_id}. RLS hid the
 * chat row, the resulting exception was swallowed, and the client received a schema-invalid
 * {@code 201} without {@code envelope_coverage} (D-S4-04). This service owns an explicit
 * read-only transaction and tenant context; failures propagate instead of degrading into a
 * response the client must reject.
 */
@Service
public class MessageReplayCoverageService {

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final MessageChatContextPort chatContext;
    private final E2eeEnvelopeValidator envelopeValidator;

    public MessageReplayCoverageService(TenantContext tenantContext, ChatAccessPort chatAccess,
                                        MessageChatContextPort chatContext,
                                        E2eeEnvelopeValidator envelopeValidator) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.chatContext = chatContext;
        this.envelopeValidator = envelopeValidator;
    }

    @Transactional(readOnly = true)
    public EnvelopeCoverageView replayCoverage(Principal principal, UUID chatId,
                                               List<CryptoEnvelope> envelopes) {
        if (principal.workspaceId() == null) {
            throw DomainException.internal();
        }
        tenantContext.activate(principal);
        chatAccess.requireActiveChat(principal.workspaceId(), chatId, principal.userId());
        var chat = chatContext.require(principal.workspaceId(), chatId, principal.userId());
        return envelopeValidator.replayCoverage(principal, chatId, chat, envelopes);
    }
}
