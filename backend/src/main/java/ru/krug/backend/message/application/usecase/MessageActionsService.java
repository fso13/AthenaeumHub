package ru.krug.backend.message.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.message.application.command.DeleteMessageScope;
import ru.krug.backend.message.application.event.MessageDeletedNotification;
import ru.krug.backend.message.application.event.MessageReactionNotification;
import ru.krug.backend.message.application.event.MessageUpdatedNotification;
import ru.krug.backend.message.application.model.MessageEditInput;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.model.ReactionSummaryView;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.message.domain.repository.MessageReactionRepository;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.message.domain.service.MessageReactionPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.ContentDlpPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Message actions #61-#63: reactions, edit and delete.
 *
 * <p>Authorisation is intentionally simple and explicit:
 * <ul>
 *   <li>every operation requires an ACTIVE membership of the chat (hidden otherwise);</li>
 *   <li>edit/reactions are managed-only — an E2EE chat answers 422
 *       {@code E2EE_METADATA_FORBIDDEN} instead of storing/returning plaintext metadata;</li>
 *   <li>edit and delete-for-all are sender-only (owner/admin gets no special right, so a
 *       moderator cannot silently rewrite or erase another author's words);</li>
 *   <li>delete-for-me is available to every active member and never affects others.</li>
 * </ul>
 * All writes are in the caller's transaction; WS events are published after commit.
 */
@Service
public class MessageActionsService {

    private static final int MAX_EDIT_LENGTH = 8000;

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final ChatWorkspacePort chatWorkspace;
    private final MessageRepository messageRepository;
    private final MessageReactionRepository reactionRepository;
    private final MessageEnvelopeRepository envelopeRepository;
    private final MessageAttachmentPort attachmentPort;
    private final MessageQueryHandler queryHandler;
    private final ContentDlpPort dlp;
    private final ClockPort clock;
    private final ApplicationEventPublisher events;

    public MessageActionsService(TenantContext tenantContext, ChatAccessPort chatAccess,
                                 ChatWorkspacePort chatWorkspace,
                                 MessageRepository messageRepository,
                                 MessageReactionRepository reactionRepository,
                                 MessageEnvelopeRepository envelopeRepository,
                                 MessageAttachmentPort attachmentPort,
                                 MessageQueryHandler queryHandler, ContentDlpPort dlp,
                                 ClockPort clock, ApplicationEventPublisher events) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.chatWorkspace = chatWorkspace;
        this.messageRepository = messageRepository;
        this.reactionRepository = reactionRepository;
        this.envelopeRepository = envelopeRepository;
        this.attachmentPort = attachmentPort;
        this.queryHandler = queryHandler;
        this.dlp = dlp;
        this.clock = clock;
        this.events = events;
    }

    @Transactional
    public MessageView edit(Principal principal, UUID chatId, UUID messageId,
                            MessageEditInput input) {
        Principal scoped = scope(principal, chatId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(scoped.workspaceId(), chatId,
                scoped.userId());
        Message message = requireMessage(scoped, chatId, messageId);
        requireManaged(access, message);
        if (messageRepository.isHiddenForUser(scoped.workspaceId(), messageId,
                scoped.userId()) || message.deletedAt() != null) {
            throw notFound();
        }
        if (!scoped.userId().equals(message.senderId())) {
            throw DomainException.forbidden("Only the sender can edit this message");
        }
        if (message.type() != Message.Type.TEXT) {
            throw DomainException.unprocessable(ErrorCode.MESSAGE_NOT_EDITABLE,
                    "Only TEXT messages can be edited", Map.of("field", "type"));
        }
        String text = validateText(input == null ? null : input.text());
        Integer expectedVersion = input == null ? null : input.version();
        if (expectedVersion != null && expectedVersion != message.version()) {
            throw versionConflict(message.version());
        }
        // #101: an edit is a new content write, so it must pass the same DLP gate as the
        // original send. A BLOCK leaves the stored message and its version untouched; the
        // content-free decision event is written independently.
        dlp.enforceText(scoped, chatId, text);
        Message updated = messageRepository.editText(scoped.workspaceId(), chatId, messageId,
                        text, expectedVersion, clock.now())
                .orElseThrow(() -> expectedVersion == null ? notFound()
                        : versionConflict(message.version()));
        MessageView view = queryHandler.findById(scoped, updated.id());
        if (view == null) {
            throw notFound();
        }
        events.publishEvent(new MessageUpdatedNotification(scoped.workspaceId(), view));
        return view;
    }

    @Transactional
    public void delete(Principal principal, UUID chatId, UUID messageId,
                       DeleteMessageScope scope) {
        Principal scoped = scope(principal, chatId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(scoped.workspaceId(), chatId,
                scoped.userId());
        Message message = requireMessage(scoped, chatId, messageId);

        if (scope == DeleteMessageScope.ME) {
            // Idempotent by the PK (message_id, user_id); hidden/foreign rows are never
            // touched. No WS event: other members must keep seeing the message.
            messageRepository.hideForUser(scoped.workspaceId(), chatId, messageId,
                    scoped.userId(), clock.now());
            return;
        }

        if (!scoped.userId().equals(message.senderId())) {
            throw DomainException.forbidden("Only the sender can delete a message for everyone");
        }
        if (message.deletedAt() != null) {
            // Idempotent 204: the tombstone already exists. No second event is emitted.
            return;
        }
        Instant deletedAt = clock.now();
        Message deleted = messageRepository.softDeleteForAll(scoped.workspaceId(), chatId,
                        messageId, deletedAt, scoped.userId())
                .orElseThrow(MessageActionsService::notFound);
        // Content-adjacent rows: reactions are removed, E2EE envelopes are purged (so the
        // tombstone cannot be decrypted) and bound attachments stop being downloadable.
        reactionRepository.deleteForMessage(scoped.workspaceId(), messageId);
        envelopeRepository.deleteByMessage(scoped.workspaceId(), messageId);
        attachmentPort.markDeletedForMessage(scoped.workspaceId(), messageId, deletedAt);
        events.publishEvent(new MessageDeletedNotification(scoped.workspaceId(), chatId,
                messageId, deleted.seq(), deletedAt, scoped.userId(), "all",
                deleted.isE2ee()));
    }

    @Transactional
    public ReactionSummaryView react(Principal principal, UUID chatId, UUID messageId,
                                     String emoji) {
        Principal scoped = scope(principal, chatId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(scoped.workspaceId(), chatId,
                scoped.userId());
        Message message = requireMessage(scoped, chatId, messageId);
        requireManaged(access, message);
        if (message.deletedAt() != null || messageRepository.isHiddenForUser(
                scoped.workspaceId(), messageId, scoped.userId())) {
            throw notFound();
        }
        MessageReactionPolicy.validate(emoji);
        reactionRepository.add(scoped.workspaceId(), chatId, messageId, scoped.userId(), emoji,
                clock.now());
        long count = reactionRepository.count(scoped.workspaceId(), messageId, emoji);
        events.publishEvent(new MessageReactionNotification(scoped.workspaceId(), chatId,
                messageId, message.seq(), scoped.userId(), emoji, "ADDED", count, false));
        return new ReactionSummaryView(emoji, count, true);
    }

    @Transactional
    public void unreact(Principal principal, UUID chatId, UUID messageId, String emoji) {
        Principal scoped = scope(principal, chatId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(scoped.workspaceId(), chatId,
                scoped.userId());
        Message message = requireMessage(scoped, chatId, messageId);
        requireManaged(access, message);
        MessageReactionPolicy.validate(emoji);
        reactionRepository.remove(scoped.workspaceId(), chatId, messageId, scoped.userId(),
                emoji);
        long count = reactionRepository.count(scoped.workspaceId(), messageId, emoji);
        events.publishEvent(new MessageReactionNotification(scoped.workspaceId(), chatId,
                messageId, message.seq(), scoped.userId(), emoji, "REMOVED", count, false));
    }

    private Message requireMessage(Principal principal, UUID chatId, UUID messageId) {
        Message message = messageRepository.findById(principal.workspaceId(), messageId)
                .orElse(null);
        if (message == null || !message.chatId().equals(chatId)) {
            throw notFound();
        }
        return message;
    }

    private static void requireManaged(ChatAccess access, Message message) {
        if ("E2EE".equals(access.securityMode()) || message.isE2ee()) {
            throw DomainException.unprocessable(ErrorCode.E2EE_METADATA_FORBIDDEN,
                    "Reactions and edits are not supported for E2EE messages",
                    Map.of("reason", "e2ee_metadata_forbidden"));
        }
    }

    private static String validateText(String text) {
        if (text == null || text.strip().isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "text must not be empty", Map.of("field", "text"));
        }
        if (text.length() > MAX_EDIT_LENGTH) {
            throw DomainException.unprocessable(ErrorCode.MESSAGE_TOO_LONG,
                    "text must be at most 8000 characters",
                    Map.of("field", "text", "max", MAX_EDIT_LENGTH));
        }
        return text;
    }

    private static DomainException versionConflict(int currentVersion) {
        return DomainException.conflict(ErrorCode.VERSION_CONFLICT,
                "Message was changed by another request", Map.of("version", currentVersion));
    }

    private static DomainException notFound() {
        return DomainException.notFound("Message not found");
    }

    private Principal scope(Principal principal, UUID chatId) {
        if (principal.workspaceId() != null) {
            return principal;
        }
        UUID workspaceId = chatWorkspace.workspaceForChat(chatId, principal.userId(),
                principal.requestId());
        return principal.withWorkspace(workspaceId);
    }
}
