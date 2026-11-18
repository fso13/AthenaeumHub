package ru.krug.backend.message.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.message.application.command.ListMessagesQuery;
import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.message.application.model.MessagePageCursor;
import ru.krug.backend.message.application.model.MessagePageView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.message.application.port.MessageDeviceDirectoryPort;
import ru.krug.backend.message.application.service.EnvelopeWireMapper;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.sticker.application.model.StickerRefView;
import ru.krug.backend.sticker.application.port.StickerCatalogPort;

/**
 * Message history/read model.
 *
 * <p>E7-B4: in an E2EE chat the server returns no plaintext and no server-side search. A
 * message carries {@code crypto} only when an envelope addressed to the caller's
 * {@code X-Device-Id} exists; envelopes of other devices (even of the same user) are never
 * returned and the number of envelopes is never disclosed.
 */
@Service
public class MessageQueryHandler {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 100;

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final MessageRepository messageRepository;
    private final MessageEnvelopeRepository envelopeRepository;
    private final ChatWorkspacePort chatWorkspace;
    private final MessageAttachmentPort attachmentPort;
    private final StickerCatalogPort stickerCatalog;
    private final E2eeSettingsPort e2eeSettings;
    private final MessageDeviceDirectoryPort deviceDirectory;

    public MessageQueryHandler(TenantContext tenantContext, ChatAccessPort chatAccess,
                               MessageRepository messageRepository,
                               MessageEnvelopeRepository envelopeRepository,
                               ChatWorkspacePort chatWorkspace,
                               MessageAttachmentPort attachmentPort,
                               StickerCatalogPort stickerCatalog,
                               E2eeSettingsPort e2eeSettings,
                               MessageDeviceDirectoryPort deviceDirectory) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.messageRepository = messageRepository;
        this.envelopeRepository = envelopeRepository;
        this.chatWorkspace = chatWorkspace;
        this.attachmentPort = attachmentPort;
        this.stickerCatalog = stickerCatalog;
        this.e2eeSettings = e2eeSettings;
        this.deviceDirectory = deviceDirectory;
    }

    @Transactional(readOnly = true)
    public MessagePageView list(ListMessagesQuery query) {
        query = scope(query);
        int limit = effectiveLimit(query.limit());
        if (query.afterSeq() != null && query.afterSeq() < 0) {
            throw DomainException.badRequest("after_seq must be >= 0",
                    Map.of("field", "after_seq"));
        }
        if (query.beforeSeq() != null && query.beforeSeq() < 0) {
            throw DomainException.badRequest("before_seq must be >= 0",
                    Map.of("field", "before_seq"));
        }

        tenantContext.activate(query.principal());
        var access = chatAccess.requireActiveChat(query.principal().workspaceId(),
                query.chatId(), query.principal().userId());
        boolean e2ee = "E2EE".equals(access.securityMode());
        if (e2ee && !e2eeSettings.enabled()) {
            throw DomainException.conflict(ErrorCode.E2EE_DISABLED,
                    "E2EE message reads are not enabled in this slice",
                    Map.of("flag", "e2ee.enabled"));
        }

        List<Message> rows = messageRepository.findPage(query.principal().workspaceId(),
                query.chatId(), query.afterSeq(), query.beforeSeq(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<MessageView> items = enrich(query.principal().workspaceId(),
                query.principal().userId(),
                (hasMore ? rows.subList(0, limit) : rows).stream()
                        .map(MessageView::from)
                        .toList());
        if (e2ee) {
            items = withCrypto(query.principal().workspaceId(),
                    query.principal().userId(), query.principal().deviceId(), items);
        }
        String nextCursor = null;
        if (hasMore && !items.isEmpty()) {
            nextCursor = new MessagePageCursor(items.get(items.size() - 1).seq()).encode();
        }
        return new MessagePageView(items, nextCursor, hasMore);
    }

    /** Used by the idempotent replay path; the sender's own device has no envelope. */
    @Transactional(readOnly = true)
    public MessageView findById(Principal principal, UUID messageId) {
        principal = scope(principal, null);
        tenantContext.activate(principal);
        Message message = messageRepository.findById(principal.workspaceId(), messageId)
                .orElse(null);
        if (message == null) {
            return null;
        }
        chatAccess.requireActiveChat(principal.workspaceId(), message.chatId(),
                principal.userId());
        return enrich(principal.workspaceId(), principal.userId(),
                List.of(MessageView.from(message))).get(0);
    }

    @Transactional(readOnly = true)
    public MessageView findByClientMessageId(Principal principal, UUID chatId, UUID clientMessageId) {
        principal = scope(principal, chatId);
        tenantContext.activate(principal);
        chatAccess.requireActiveChat(principal.workspaceId(), chatId, principal.userId());
        MessageView view = messageRepository.findByClientMessageId(principal.workspaceId(),
                        chatId, clientMessageId, principal.userId())
                .map(MessageView::from)
                .orElse(null);
        return view == null ? null
                : enrich(principal.workspaceId(), principal.userId(), List.of(view)).get(0);
    }

    /**
     * Envelopes of one message, for the idempotent replay equality check. Tenant context is
     * activated here because the caller resolved the message outside a transaction.
     */
    @Transactional(readOnly = true)
    public List<ru.krug.backend.message.domain.model.CryptoEnvelope> envelopesOf(
            Principal principal, UUID chatId, UUID messageId) {
        principal = scope(principal, chatId);
        tenantContext.activate(principal);
        chatAccess.requireActiveChat(principal.workspaceId(), chatId, principal.userId());
        return envelopeRepository.findByMessage(principal.workspaceId(), messageId).stream()
                .map(MessageEnvelope::envelope)
                .toList();
    }

    /**
     * Sender of an existing message with the same client_message_id, if any. Used only to
     * answer 409 CLIENT_MESSAGE_ID_CONFLICT when another user used the same value.
     */
    @Transactional(readOnly = true)
    public UUID senderIdForClientMessageId(Principal principal, UUID chatId,
                                           UUID clientMessageId) {
        principal = scope(principal, chatId);
        tenantContext.activate(principal);
        chatAccess.requireActiveChat(principal.workspaceId(), chatId, principal.userId());
        return messageRepository.findSenderIdByClientMessageId(principal.workspaceId(), chatId,
                clientMessageId).orElse(null);
    }

    /**
     * E2EE-REVIEW-06 P0-01 defense-in-depth: the requested device must belong to the
     * caller and be ACTIVE before any envelope is read. The controller/filter already
     * enforce this, but a future path-matching bug must not turn into a cross-device
     * envelope leak. The caller is a member of the chat (checked above); the device is
     * bound to the caller, so device ownership also implies chat membership.
     */
    private List<MessageView> withCrypto(UUID workspaceId, UUID userId, UUID deviceId,
                                         List<MessageView> views) {
        if (views.isEmpty()) {
            return views;
        }
        if (deviceId == null) {
            throw DomainException.forbidden("X-Device-Id is required for E2EE history");
        }
        var device = deviceDirectory.findDevice(deviceId)
                .orElseThrow(() -> DomainException.forbidden(
                        "X-Device-Id is not an active device of the caller"));
        if (!device.active() || !userId.equals(device.userId())) {
            throw DomainException.forbidden(
                    "X-Device-Id is not an active device of the caller");
        }
        Map<UUID, MessageEnvelope> envelopes = envelopeRepository.findForDevice(workspaceId,
                views.stream().map(MessageView::id).toList(), deviceId);
        return views.stream()
                .map(view -> view.withCrypto(envelopes.containsKey(view.id())
                        ? EnvelopeWireMapper.toWire(envelopes.get(view.id()).envelope()) : null))
                .toList();
    }

    private List<MessageView> enrich(UUID workspaceId, UUID viewerId, List<MessageView> views) {
        if (views.isEmpty()) {
            return views;
        }
        Map<UUID, List<MessageAttachmentView>> byMessage = attachmentPort.findByMessageIds(
                workspaceId, views.stream().map(MessageView::id).toList());
        List<UUID> stickerIds = views.stream()
                .map(MessageView::stickerId)
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
        Map<UUID, StickerRefView> stickers = stickerIds.isEmpty() ? Map.of()
                : stickerCatalog.findForMessage(viewerId, stickerIds);
        return views.stream()
                .map(view -> view.withAttachments(byMessage.getOrDefault(view.id(), List.of()))
                        .withSticker(view.stickerId() == null ? null
                                : stickers.get(view.stickerId())))
                .toList();
    }

    private ListMessagesQuery scope(ListMessagesQuery query) {
        Principal scoped = scope(query.principal(), query.chatId());
        if (scoped.equals(query.principal())) {
            return query;
        }
        return new ListMessagesQuery(scoped, query.chatId(), query.afterSeq(), query.beforeSeq(),
                query.limit());
    }

    private Principal scope(Principal principal, UUID chatId) {
        if (principal.workspaceId() != null || chatId == null) {
            return principal;
        }
        UUID workspaceId = chatWorkspace.workspaceForChat(chatId, principal.userId(),
                principal.requestId());
        return principal.withWorkspace(workspaceId);
    }

    private static int effectiveLimit(Integer requested) {
        int limit = requested == null ? DEFAULT_LIMIT : requested;
        if (limit < 1 || limit > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and 100",
                    Map.of("field", "limit", "max", MAX_LIMIT));
        }
        return limit;
    }
}
