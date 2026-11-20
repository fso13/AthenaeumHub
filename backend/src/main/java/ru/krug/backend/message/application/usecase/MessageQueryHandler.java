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
import ru.krug.backend.message.application.model.ReactionSummaryView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.message.application.port.MessageDeviceDirectoryPort;
import ru.krug.backend.message.application.port.MessagePluginContentPort;
import ru.krug.backend.message.application.service.EnvelopeWireMapper;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.domain.model.MessageReaction;
import ru.krug.backend.message.domain.model.ThreadSummary;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.message.domain.repository.MessageReactionRepository;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.message.domain.service.MessageThreadPolicy;
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
    private final MessageReactionRepository reactionRepository;
    private final ChatWorkspacePort chatWorkspace;
    private final MessageAttachmentPort attachmentPort;
    private final StickerCatalogPort stickerCatalog;
    private final E2eeSettingsPort e2eeSettings;
    private final MessageDeviceDirectoryPort deviceDirectory;
    private final MessagePluginContentPort pluginContent;

    public MessageQueryHandler(TenantContext tenantContext, ChatAccessPort chatAccess,
                               MessageRepository messageRepository,
                               MessageEnvelopeRepository envelopeRepository,
                               MessageReactionRepository reactionRepository,
                               ChatWorkspacePort chatWorkspace,
                               MessageAttachmentPort attachmentPort,
                               StickerCatalogPort stickerCatalog,
                               E2eeSettingsPort e2eeSettings,
                               MessageDeviceDirectoryPort deviceDirectory,
                               MessagePluginContentPort pluginContent) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.messageRepository = messageRepository;
        this.envelopeRepository = envelopeRepository;
        this.reactionRepository = reactionRepository;
        this.chatWorkspace = chatWorkspace;
        this.attachmentPort = attachmentPort;
        this.stickerCatalog = stickerCatalog;
        this.e2eeSettings = e2eeSettings;
        this.deviceDirectory = deviceDirectory;
        this.pluginContent = pluginContent;
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
        if (query.threadRootId() != null) {
            // D1 threads are managed-only: E2EE has no server-visible thread metadata.
            MessageThreadPolicy.ensureThreadsSupported(e2ee);
            Message root = messageRepository.findById(query.principal().workspaceId(),
                    query.threadRootId()).orElse(null);
            MessageThreadPolicy.ensureThreadRoot(query.chatId(), query.threadRootId(), root);
        }

        List<Message> rows = query.threadRootId() == null
                ? messageRepository.findMainPage(query.principal().workspaceId(),
                        query.chatId(), query.afterSeq(), query.beforeSeq(),
                        query.principal().userId(), limit + 1)
                : messageRepository.findThreadPage(query.principal().workspaceId(),
                        query.chatId(), query.threadRootId(), query.afterSeq(),
                        query.beforeSeq(), query.principal().userId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<MessageView> items = enrich(query.principal().workspaceId(),
                query.principal().userId(),
                (hasMore ? rows.subList(0, limit) : rows).stream()
                        .map(MessageView::from)
                        .toList());
        if (e2ee) {
            items = withCrypto(query.principal().workspaceId(),
                    query.principal().userId(), query.principal().deviceId(), items);
        } else if (query.threadRootId() == null) {
            items = withThreadSummaries(query.principal().workspaceId(), query.chatId(),
                    query.principal().userId(), items);
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
        if (messageRepository.isHiddenForUser(principal.workspaceId(), messageId,
                principal.userId())) {
            return null;
        }
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
        // Reactions are managed-only metadata; an E2EE page never queries them and never
        // exposes a count that could reveal who interacted with an encrypted timeline.
        List<UUID> managedIds = views.stream().filter(view -> !view.isE2ee())
                .map(MessageView::id).toList();
        Map<UUID, List<ReactionSummaryView>> reactions = managedIds.isEmpty() ? Map.of()
                : reactionView(reactionRepository.summarize(workspaceId, managedIds, viewerId));
        // #95: current poll/task projections are resolved in one bounded query per kind and
        // are viewer-relative (my_option_id is the caller's choice). Tombstones get them
        // dropped below, exactly like sticker/attachment metadata.
        List<UUID> pollIds = views.stream()
                .filter(view -> view.pluginContent() != null)
                .map(view -> view.pluginContent().pollId())
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
        List<UUID> taskIds = views.stream()
                .filter(view -> view.pluginContent() != null)
                .map(view -> view.pluginContent().taskId())
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
        Map<UUID, EmbeddedPollView> polls = pollIds.isEmpty() ? Map.of()
                : pluginContent.findPolls(workspaceId, views.get(0).chatId(), pollIds, viewerId);
        Map<UUID, EmbeddedTaskView> tasks = taskIds.isEmpty() ? Map.of()
                : pluginContent.findTasks(workspaceId, views.get(0).chatId(), taskIds, viewerId);
        return views.stream()
                // D1-BE2 defense-in-depth: an E2EE message must never expose a managed
                // attachment (and therefore its plaintext media metadata), even if a row
                // was created by a bug or direct SQL outside the API guards.
                .map(view -> view.withAttachments(view.isE2ee() ? List.of()
                                : byMessage.getOrDefault(view.id(), List.of()))
                        .withSticker(view.stickerId() == null ? null
                                : stickers.get(view.stickerId()))
                        .withReactions(reactions.getOrDefault(view.id(), List.of()))
                        .withPluginContent(
                                view.pluginContent() == null
                                        || view.pluginContent().pollId() == null ? null
                                        : polls.get(view.pluginContent().pollId()),
                                view.pluginContent() == null
                                        || view.pluginContent().taskId() == null ? null
                                        : tasks.get(view.pluginContent().taskId()))
                        // A deleted-for-all row keeps its seq but never leaks text, sticker,
                        // attachment, poll/task or reaction metadata even if legacy SQL
                        // left them.
                        .asTombstone())
                .toList();
    }

    private static Map<UUID, List<ReactionSummaryView>> reactionView(
            Map<UUID, List<MessageReaction>> rows) {
        Map<UUID, List<ReactionSummaryView>> result = new java.util.LinkedHashMap<>();
        rows.forEach((messageId, reactions) -> result.put(messageId, reactions.stream()
                .map(reaction -> new ReactionSummaryView(reaction.emoji(), reaction.count(),
                        reaction.me()))
                .toList()));
        return result;
    }

    /**
     * D1-BE1: one windowed summary query per page. Main-feed items are roots by definition,
     * so only their ids are passed; replies never receive a summary. E2EE never reaches
     * this method, and the summary itself is managed-only.
     */
    private List<MessageView> withThreadSummaries(UUID workspaceId, UUID chatId, UUID viewerId,
                                                  List<MessageView> views) {
        List<UUID> rootIds = views.stream()
                .filter(view -> view.threadRootId() == null)
                .map(MessageView::id)
                .distinct()
                .toList();
        if (rootIds.isEmpty()) {
            return views;
        }
        Map<UUID, ThreadSummary> summaries = messageRepository.findThreadSummaries(
                workspaceId, chatId, rootIds, viewerId);
        // Every managed root carries a summary, including reply_count=0: the client can
        // render "create thread" without a second request. Replies keep null.
        return views.stream()
                .map(view -> view.threadRootId() == null && view.deletedAt() == null
                        ? view.withThreadSummary(summaries.getOrDefault(view.id(),
                                ThreadSummary.empty(view.id())))
                        : view)
                .toList();
    }

    private ListMessagesQuery scope(ListMessagesQuery query) {
        Principal scoped = scope(query.principal(), query.chatId());
        if (scoped.equals(query.principal())) {
            return query;
        }
        return new ListMessagesQuery(scoped, query.chatId(), query.afterSeq(), query.beforeSeq(),
                query.limit(), query.threadRootId());
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
