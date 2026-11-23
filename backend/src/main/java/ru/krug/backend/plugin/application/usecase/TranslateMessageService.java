package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.model.TranslationView;
import ru.krug.backend.plugin.application.port.TranslationProviderPort;
import ru.krug.backend.plugin.application.port.TranslationUnavailableException;
import ru.krug.backend.plugin.domain.service.PluginTextPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.ContentDlpPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Translate plugin action ({@code #76}).
 *
 * <p>Only a managed {@code TEXT} message that is visible to an ACTIVE member of a chat with
 * the {@code translate} plugin enabled can be translated. E2EE chats/messages are rejected
 * before any content is read ({@code 422 E2EE_METADATA_FORBIDDEN}). The default provider is
 * unconfigured, so the endpoint answers {@code 503 TRANSLATION_UNAVAILABLE} with
 * {@code Retry-After} and makes no external call; a fabricated translation is never
 * returned. Audit carries only the message id and the action — never the text.</p>
 */
@Service
public class TranslateMessageService {

    static final String PLUGIN_ID = "translate";
    static final String ACTION = "chat.message.translated";
    private static final long RETRY_AFTER_SECONDS = 30L;

    private final PluginActionGate gate;
    private final MessageRepository messages;
    private final TranslationProviderPort provider;
    private final AuditPort audit;
    private final ContentDlpPort dlp;
    private final ClockPort clock;

    public TranslateMessageService(PluginActionGate gate, MessageRepository messages,
                                   TranslationProviderPort provider, AuditPort audit,
                                   ContentDlpPort dlp, ClockPort clock) {
        this.gate = gate;
        this.messages = messages;
        this.provider = provider;
        this.audit = audit;
        this.dlp = dlp;
        this.clock = clock;
    }

    @Transactional
    public TranslationView translate(Principal principal, UUID chatId, UUID messageId,
                                     String target) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        String targetLanguage = PluginTextPolicy.requireTargetLanguage(target);
        Message message = messages.findById(context.workspaceId(), messageId).orElse(null);
        if (message == null || !message.chatId().equals(chatId) || message.deletedAt() != null
                || messages.isHiddenForUser(context.workspaceId(), messageId,
                        principal.userId())) {
            throw DomainException.notFound("Message not found");
        }
        if ("E2EE".equals(context.securityMode()) || message.isE2ee()) {
            throw DomainException.unprocessable(ErrorCode.E2EE_METADATA_FORBIDDEN,
                    "Translation is not supported for E2EE messages",
                    Map.of("reason", "e2ee_metadata_forbidden"));
        }
        if (message.type() != Message.Type.TEXT || message.body() == null) {
            throw DomainException.unprocessable(ErrorCode.MESSAGE_NOT_TRANSLATABLE,
                    "Only managed TEXT messages can be translated",
                    Map.of("reason", "not_text"));
        }
        // #101: the translation input is plugin content leaving the server boundary. A
        // BLOCK is answered before any provider call; the decision event never stores the
        // message text.
        Principal scoped = principal.withWorkspace(context.workspaceId());
        dlp.enforcePluginPayload(scoped, chatId, List.of(message.body().value()));
        String translated;
        try {
            translated = provider.translate(message.body().value(), targetLanguage);
        } catch (TranslationUnavailableException ex) {
            throw unavailable();
        }
        translated = PluginTextPolicy.requireTranslated(translated);
        // The provider output is new content as well; a blocked result is never returned or
        // audited, and no provider payload is written to a log.
        dlp.enforcePluginPayload(scoped, chatId, List.of(translated));
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                "message", messageId, principal.requestId(), Map.of(), clock.now()));
        return new TranslationView(translated);
    }

    private static DomainException unavailable() {
        return DomainException.serviceUnavailable(ErrorCode.TRANSLATION_UNAVAILABLE,
                "Translation provider is not configured or unavailable",
                Map.of("reason", "provider_unavailable"), RETRY_AFTER_SECONDS);
    }
}
