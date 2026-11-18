package ru.krug.backend.message.application.usecase;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.port.UserProfilePort;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.SeqAllocator;
import ru.krug.backend.message.application.command.SendMessageCommand;
import ru.krug.backend.message.application.event.MessageCreatedNotification;
import ru.krug.backend.message.application.model.AttachmentMediaView;
import ru.krug.backend.message.application.model.E2eeSendPlan;
import ru.krug.backend.message.application.model.EnvelopeBatch;
import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.message.application.model.MessageCreateInput;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.model.SendMessageResult;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.message.application.port.MessageChatContextPort;
import ru.krug.backend.message.application.service.E2eeEnvelopeValidator;
import ru.krug.backend.message.application.service.EnvelopeFingerprint;
import ru.krug.backend.message.domain.event.MessageCreatedEvent;
import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;
import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.message.domain.service.MessageReplyPolicy;
import ru.krug.backend.message.domain.service.MessageThreadPolicy;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.model.OutboxEvent;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.ops.application.port.OutboxPort;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.sticker.application.model.StickerRefView;
import ru.krug.backend.sticker.application.port.StickerCatalogPort;

/**
 * Transactional message creation. B-02 makes the whole send atomic: the idempotency
 * advisory lock, the in-progress row, seq allocation, the aggregate insert, the outbox row
 * and the completed idempotency row commit together. A crash therefore cannot leave a
 * committed in-progress reservation, and a concurrent duplicate receives the contract's
 * 409 IDEMPOTENCY_IN_PROGRESS (its try-lock fails) until the winner commits, after which a
 * retry replays the original message.
 *
 * <p>E7-B3/B4: in an E2EE chat the only accepted payload is {@code envelopes[]}. Every
 * envelope is validated against the public device state before {@code seq} allocation, the
 * message row keeps no plaintext, and envelopes are stored as opaque bytes.
 */
@Service
public class MessageSubmissionHandler {

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final SeqAllocator seqAllocator;
    private final MessageRepository messageRepository;
    private final MessageEnvelopeRepository envelopeRepository;
    private final UserProfilePort userProfile;
    private final OutboxPort outbox;
    private final IdempotencyPort idempotency;
    private final RateLimitPort rateLimit;
    private final MessageQueryHandler queryHandler;
    private final MessageAttachmentPort attachmentPort;
    private final StickerCatalogPort stickerCatalog;
    private final MessageChatContextPort chatContext;
    private final E2eeEnvelopeValidator envelopeValidator;
    private final E2eeSettingsPort e2eeSettings;
    private final ClockPort clock;
    private final ApplicationEventPublisher events;

    public MessageSubmissionHandler(TenantContext tenantContext, ChatAccessPort chatAccess,
                                    SeqAllocator seqAllocator,
                                    MessageRepository messageRepository,
                                    MessageEnvelopeRepository envelopeRepository,
                                    UserProfilePort userProfile, OutboxPort outbox,
                                    IdempotencyPort idempotency, RateLimitPort rateLimit,
                                    MessageQueryHandler queryHandler,
                                    MessageAttachmentPort attachmentPort,
                                    StickerCatalogPort stickerCatalog,
                                    MessageChatContextPort chatContext,
                                    E2eeEnvelopeValidator envelopeValidator,
                                    E2eeSettingsPort e2eeSettings, ClockPort clock,
                                    ApplicationEventPublisher events) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.seqAllocator = seqAllocator;
        this.messageRepository = messageRepository;
        this.envelopeRepository = envelopeRepository;
        this.userProfile = userProfile;
        this.outbox = outbox;
        this.idempotency = idempotency;
        this.rateLimit = rateLimit;
        this.queryHandler = queryHandler;
        this.attachmentPort = attachmentPort;
        this.stickerCatalog = stickerCatalog;
        this.chatContext = chatContext;
        this.envelopeValidator = envelopeValidator;
        this.e2eeSettings = e2eeSettings;
        this.clock = clock;
        this.events = events;
    }

    @Transactional
    public SendMessageResult submit(Principal principal, UUID chatId, UUID idempotencyKey,
                                    byte[] requestHash, MessageCreateInput input,
                                    EnvelopeBatch envelopes) {
        tenantContext.activate(principal);
        var access = chatAccess.requireActiveChat(principal.workspaceId(), chatId,
                principal.userId());
        boolean e2eeChat = "E2EE".equals(access.securityMode());
        // P2-03: the kill-switch runs before the idempotency reservation, so a stored
        // Idempotency-Key cannot replay an E2EE message while the flag is off. Managed
        // messages are unaffected.
        requireE2eeEnabled(e2eeChat, envelopes);

        IdempotencyReservation reservation = idempotency.reserve(principal,
                SendMessageCommand.IDEMPOTENCY_SCOPE, idempotencyKey.toString(), requestHash);
        if (reservation.replay()) {
            SendMessageResult replayed = replay(principal, reservation, chatId);
            if (replayed.message().isE2ee() && !e2eeSettings.enabled()) {
                throw e2eeDisabled();
            }
            return replayed;
        }

        // Replays bypass the limiter (they do no work); a real send consumes quota. If the
        // limiter rejects, the whole transaction rolls back, including the reservation.
        rateLimit.checkMessageSend(principal, chatId);
        if (e2eeChat) {
            return submitE2ee(principal, chatId, idempotencyKey, requestHash, input, envelopes);
        }
        if (envelopes.present()) {
            throw DomainException.unprocessable(ErrorCode.ENVELOPES_NOT_ALLOWED,
                    "envelopes are only accepted in an E2EE chat",
                    Map.of("field", "envelopes", "required_mode", "E2EE"));
        }

        // Domain invariants are checked before seq allocation so invalid input leaves no gap.
        // Text is optional when attachments are present (OpenAPI MessageCreate). A STICKER
        // message has no body and exactly one catalog-resolved sticker.
        if (!input.isSticker() && !input.hasText() && !input.hasAttachments()) {
            throw DomainException.badRequest("text or attachment_ids must be present",
                    Map.of("field", "text", "reason", "empty_message"));
        }
        if (input.threadRootId() != null) {
            Message root = messageRepository.findById(principal.workspaceId(),
                    input.threadRootId()).orElse(null);
            MessageThreadPolicy.ensureThreadRoot(chatId, input.threadRootId(), root);
        }
        MessageBody body = !input.isSticker() && input.hasText()
                ? new MessageBody(input.text()) : null;
        if (input.replyToId() != null) {
            Optional<UUID> targetChat = messageRepository.findChatIdByMessageId(
                    principal.workspaceId(), chatId, input.replyToId());
            MessageReplyPolicy.ensureReplyTarget(chatId, input.replyToId(), targetChat);
        }

        StickerRefView sticker = input.isSticker()
                ? stickerCatalog.resolveForMessage(principal.userId(), input.stickerId())
                : null;

        String senderDisplayName = userProfile.displayName(principal.userId());
        long seq = seqAllocator.nextSeq(principal.workspaceId(), chatId);
        Instant now = clock.now();

        UUID messageId = UUID.randomUUID();
        // Bind before insert: the attachment rows are updated in this same transaction, so a
        // failed message insert cannot leave attachments bound to a non-existent message.
        List<MessageAttachmentView> attachments = attachmentPort.bind(principal,
                principal.workspaceId(), chatId, messageId, input.attachmentIds());

        Message message = input.isSticker()
                ? Message.createSticker(messageId, principal.workspaceId(), chatId, seq,
                        principal.userId(), principal.deviceId(), senderDisplayName,
                        input.stickerId(), input.replyToId(), input.threadRootId(),
                        input.clientMessageId(), now)
                : Message.createText(messageId, principal.workspaceId(), chatId, seq,
                        principal.userId(), principal.deviceId(), senderDisplayName, body,
                        input.replyToId(), input.threadRootId(), input.clientMessageId(), now);
        messageRepository.save(message);

        MessageView view = MessageView.from(message).withAttachments(attachments)
                .withSticker(sticker);
        MessageCreatedEvent event = new MessageCreatedEvent(message.id(), principal.workspaceId(),
                chatId, seq, principal.userId(), now,
                input.hasText() ? input.text().getBytes(StandardCharsets.UTF_8).length : 0);
        outbox.append(new OutboxEvent(principal.workspaceId(), "message", message.id(),
                "message.created", 1, chatId.toString(), payload(event, view), now));

        idempotency.complete(principal, SendMessageCommand.IDEMPOTENCY_SCOPE,
                idempotencyKey.toString(), requestHash, 201, message.id());
        // Realtime fan-out listens AFTER_COMMIT; a rollback (including idempotency failure)
        // never reaches WS subscribers.
        events.publishEvent(new MessageCreatedNotification(principal.workspaceId(), view));
        return new SendMessageResult(201, view, false);
    }

    private SendMessageResult submitE2ee(Principal principal, UUID chatId, UUID idempotencyKey,
                                         byte[] requestHash, MessageCreateInput input,
                                         EnvelopeBatch envelopes) {
        requireE2eePayload(input, envelopes);
        var chat = chatContext.require(principal.workspaceId(), chatId, principal.userId());

        // Client_message_id replay pre-check (deterministic, not a race): same sender + same
        // bytes -> replay; same id with other bytes/other sender -> conflict. It runs before
        // device validation so a replay survives an unrelated key/device state change.
        Optional<Message> existing = messageRepository.findByClientMessageId(
                principal.workspaceId(), chatId, input.clientMessageId(), principal.userId());
        if (existing.isPresent()) {
            return replayByClientMessageId(principal, idempotencyKey, requestHash, existing.get(),
                    envelopes.envelopes());
        }
        if (messageRepository.findSenderIdByClientMessageId(principal.workspaceId(), chatId,
                input.clientMessageId()).isPresent()) {
            throw clientMessageIdConflict(input.clientMessageId());
        }
        E2eeSendPlan plan = envelopeValidator.validate(principal, chatId, chat,
                envelopes.envelopes());

        String senderDisplayName = userProfile.displayName(principal.userId());
        long seq = seqAllocator.nextSeq(principal.workspaceId(), chatId);
        Instant now = clock.now();
        UUID messageId = UUID.randomUUID();

        Message message = Message.createE2ee(messageId, principal.workspaceId(), chatId, seq,
                principal.userId(), principal.deviceId(), senderDisplayName,
                input.clientMessageId(), now);
        messageRepository.save(message);
        List<MessageEnvelope> rows = plan.envelopes().stream()
                .map(envelope -> new MessageEnvelope(messageId, principal.workspaceId(), chatId,
                        now, envelope))
                .toList();
        envelopeRepository.saveAll(rows);

        MessageView view = MessageView.from(message);
        MessageCreatedEvent event = new MessageCreatedEvent(messageId, principal.workspaceId(),
                chatId, seq, principal.userId(), now, 0);
        outbox.append(new OutboxEvent(principal.workspaceId(), "message", messageId,
                "message.created", 1, chatId.toString(), payload(event, view), now));
        idempotency.complete(principal, SendMessageCommand.IDEMPOTENCY_SCOPE,
                idempotencyKey.toString(), requestHash, 201, messageId);
        events.publishEvent(new MessageCreatedNotification(principal.workspaceId(), view,
                plan.cryptoByDevice()));
        return new SendMessageResult(201, view, false, plan.coverage());
    }

    private void requireE2eePayload(MessageCreateInput input, EnvelopeBatch envelopes) {
        // D1: threads are managed-only. Checked first so the caller gets the explicit
        // THREADS_E2EE_UNSUPPORTED code instead of a generic plaintext error.
        if (input.threadRootId() != null) {
            throw DomainException.unprocessable(ErrorCode.THREADS_E2EE_UNSUPPORTED,
                    "Threads are not supported in E2EE chats",
                    Map.of("field", "thread_root_id"));
        }
        if (!envelopes.present() || envelopes.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.ENVELOPES_REQUIRED,
                    "An E2EE message requires at least one envelope",
                    Map.of("field", "envelopes"));
        }
        if (!"TEXT".equals(input.type())) {
            throw plaintext("type", "E2EE messages are type TEXT");
        }
        if (input.text() != null) {
            throw plaintext("text", "text is forbidden in an E2EE chat");
        }
        if (input.hasSticker()) {
            throw plaintext("sticker_id", "sticker_id is forbidden in an E2EE chat");
        }
        if (input.hasAttachments()) {
            throw plaintext("attachment_ids", "attachment_ids are forbidden in an E2EE chat");
        }
        if (input.replyToId() != null) {
            throw plaintext("reply_to_id",
                    "reply_to_id is carried inside the encrypted payload");
        }
    }

    private static DomainException plaintext(String field, String message) {
        return DomainException.unprocessable(ErrorCode.E2EE_PLAINTEXT_FORBIDDEN, message,
                Map.of("field", field));
    }

    private SendMessageResult replayByClientMessageId(Principal principal, UUID idempotencyKey,
                                                      byte[] requestHash, Message existing,
                                                      List<CryptoEnvelope> envelopes) {
        List<CryptoEnvelope> stored = storedEnvelopes(principal.workspaceId(), existing.id());
        if (!EnvelopeFingerprint.of(stored).equals(EnvelopeFingerprint.of(envelopes))) {
            throw clientMessageIdConflict(existing.clientMessageId());
        }
        MessageView view = queryHandler.findById(principal, existing.id());
        if (view == null) {
            throw DomainException.conflict(ErrorCode.CONFLICT,
                    "Idempotent replay target is no longer available", Map.of());
        }
        idempotency.complete(principal, SendMessageCommand.IDEMPOTENCY_SCOPE,
                idempotencyKey.toString(), requestHash, 201, existing.id());
        var chat = chatContext.require(principal.workspaceId(), existing.chatId(),
                principal.userId());
        return new SendMessageResult(201, view, true,
                envelopeValidator.replayCoverage(principal, existing.chatId(), chat, stored));
    }

    private static DomainException clientMessageIdConflict(UUID clientMessageId) {
        return DomainException.conflict(ErrorCode.CLIENT_MESSAGE_ID_CONFLICT,
                "client_message_id was already used with a different message",
                Map.of("client_message_id", String.valueOf(clientMessageId)));
    }

    private List<CryptoEnvelope> storedEnvelopes(UUID workspaceId, UUID messageId) {
        return envelopeRepository.findByMessage(workspaceId, messageId).stream()
                .map(MessageEnvelope::envelope)
                .toList();
    }

    private SendMessageResult replay(Principal principal, IdempotencyReservation reservation,
                                     UUID chatId) {
        MessageView replayed = queryHandler.findById(principal, reservation.resourceId());
        if (replayed == null) {
            throw DomainException.conflict(ErrorCode.CONFLICT,
                    "Idempotent replay target is no longer available", Map.of());
        }
        if (!replayed.isE2ee()) {
            return new SendMessageResult(201, replayed, true);
        }
        if (!e2eeSettings.enabled()) {
            throw e2eeDisabled();
        }
        var chat = chatContext.require(principal.workspaceId(), chatId, principal.userId());
        return new SendMessageResult(201, replayed, true, envelopeValidator.replayCoverage(
                principal, chatId, chat,
                storedEnvelopes(principal.workspaceId(), replayed.id())));
    }

    private void requireE2eeEnabled(boolean e2eeChat, EnvelopeBatch envelopes) {
        // Flag off: every E2EE operation is rejected before anything is parsed or stored.
        // Never fall back to plaintext in an E2EE chat.
        if ((e2eeChat || envelopes.present()) && !e2eeSettings.enabled()) {
            throw e2eeDisabled();
        }
    }

    private static DomainException e2eeDisabled() {
        return DomainException.conflict(ErrorCode.E2EE_DISABLED,
                "E2EE messages are not enabled in this slice",
                Map.of("flag", "e2ee.enabled"));
    }

    private static Map<String, Object> mediaMap(AttachmentMediaView media) {
        if (media == null) {
            return null;
        }
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("kind", media.kind());
        item.put("duration_ms", media.durationMs());
        item.put("width", media.width());
        item.put("height", media.height());
        item.put("title", media.title());
        item.put("artist", media.artist());
        item.put("album", media.album());
        item.put("year", media.year());
        item.put("genre", media.genre());
        item.put("artwork_url", media.artworkUrl());
        item.put("metadata_source", media.metadataSource());
        return item;
    }

    private static Map<String, Object> payload(MessageCreatedEvent event, MessageView view) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("message_id", event.messageId());
        payload.put("chat_id", event.chatId());
        payload.put("seq", event.seq());
        payload.put("sender_id", event.senderId());
        payload.put("type", view.type());
        payload.put("thread_root_id", view.threadRootId());
        payload.put("sticker_id", view.stickerId());
        if (view.sticker() != null) {
            payload.put("sticker", Map.of(
                    "id", view.sticker().id(),
                    "pack_id", view.sticker().packId(),
                    "alt", view.sticker().alt(),
                    "url", view.sticker().url(),
                    "favorite", view.sticker().favorite()));
        }
        payload.put("created_at", event.createdAt().toString());
        payload.put("size_bytes", event.sizeBytes());
        payload.put("attachments", view.attachments().stream().map(attachment -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", attachment.id());
            item.put("filename", attachment.filename());
            item.put("size_bytes", attachment.sizeBytes());
            item.put("mime_type", attachment.mimeType());
            item.put("scan_status", attachment.scanStatus());
            item.put("media", mediaMap(attachment.media()));
            return item;
        }).toList());
        return payload;
    }
}
