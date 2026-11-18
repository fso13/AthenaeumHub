package ru.krug.backend.message.application.usecase;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.message.application.command.SendMessageCommand;
import ru.krug.backend.message.application.model.EnvelopeBatch;
import ru.krug.backend.message.application.model.EnvelopeCoverageView;
import ru.krug.backend.message.application.model.MessageCreateInput;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.model.SendMessageResult;
import ru.krug.backend.message.application.service.EnvelopeCodec;
import ru.krug.backend.message.application.service.EnvelopeFingerprint;
import ru.krug.backend.message.application.service.MessageReplayCoverageService;
import ru.krug.backend.message.domain.exception.InvalidStickerMessageException;
import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Orchestrator for a send. B-02 replaced the two-transaction saga with one atomic
 * transaction in {@link MessageSubmissionHandler}; this class only scopes the request,
 * parses opaque envelopes, validates the schema, hashes the body and recovers the rare
 * client_message_id race (the unique index fires at commit, after the message transaction
 * has rolled back).
 */
@Service
public class SendMessageUseCase {

    private static final Logger log = LoggerFactory.getLogger(SendMessageUseCase.class);

    private final IdempotencyPort idempotency;
    private final MessageSubmissionHandler submissionHandler;
    private final MessageQueryHandler queryHandler;
    private final RequestCanonicalizer canonicalizer;
    private final ChatWorkspacePort chatWorkspace;
    private final MessageReplayCoverageService replayCoverageService;
    private final E2eeSettingsPort e2eeSettings;

    public SendMessageUseCase(IdempotencyPort idempotency,
                              MessageSubmissionHandler submissionHandler,
                              MessageQueryHandler queryHandler,
                              RequestCanonicalizer canonicalizer,
                              ChatWorkspacePort chatWorkspace,
                              MessageReplayCoverageService replayCoverageService,
                              E2eeSettingsPort e2eeSettings) {
        this.idempotency = idempotency;
        this.submissionHandler = submissionHandler;
        this.queryHandler = queryHandler;
        this.canonicalizer = canonicalizer;
        this.chatWorkspace = chatWorkspace;
        this.replayCoverageService = replayCoverageService;
        this.e2eeSettings = e2eeSettings;
    }

    public SendMessageResult send(SendMessageCommand command) {
        command = scope(command);
        EnvelopeBatch envelopes = parseEnvelopes(command.input());
        validateSchema(command.input(), envelopes);
        byte[] requestHash = requestHash(command, envelopes);

        try {
            return submissionHandler.submit(command.principal(), command.chatId(),
                    command.idempotencyKey(), requestHash, command.input(), envelopes);
        } catch (DomainException ex) {
            // Intentional API errors (409 reused/in-progress, 422, 429) must not be
            // rewritten by the client_message_id recovery branch below.
            throw ex;
        } catch (RuntimeException ex) {
            // The unique index on (chat_id, sender_id, client_message_id) is checked at
            // flush/commit, i.e. after the message transaction (including its idempotency
            // row) rolled back. Resolve the race outside that transaction and persist the
            // replay row.
            MessageView existing = lookupExistingQuietly(command);
            if (existing != null && sameContent(command, existing, envelopes)) {
                completeQuietly(command, requestHash, existing.id());
                return new SendMessageResult(201, existing, true,
                        replayCoverage(command, existing, envelopes));
            }
            if (existing != null) {
                throw clientMessageIdConflict(command.input().clientMessageId());
            }
            if (anotherSenderUsedClientMessageId(command)) {
                throw clientMessageIdConflict(command.input().clientMessageId());
            }
            throw ex;
        }
    }

    private EnvelopeBatch parseEnvelopes(MessageCreateInput input) {
        if (input == null || !input.envelopesPresent()) {
            return EnvelopeBatch.ABSENT;
        }
        if (!e2eeSettings.enabled()) {
            // Flag off: the handler answers 409 E2EE_DISABLED before any parsing, exactly
            // like every other E2EE operation. Malformed envelopes must not change that.
            return new EnvelopeBatch(true, List.of());
        }
        return new EnvelopeBatch(true, EnvelopeCodec.parse(input.envelopes()));
    }

    private SendMessageCommand scope(SendMessageCommand command) {
        if (command.principal().workspaceId() != null) {
            return command;
        }
        var workspaceId = chatWorkspace.workspaceForChat(command.chatId(),
                command.principal().userId(), command.principal().requestId());
        return command.withPrincipal(command.principal().withWorkspace(workspaceId));
    }

    private void validateSchema(MessageCreateInput input, EnvelopeBatch envelopes) {
        if (input == null || input.clientMessageId() == null) {
            throw DomainException.badRequest("client_message_id is required",
                    Map.of("field", "client_message_id"));
        }
        if (envelopes.present()) {
            // Managed-vs-E2EE payload rules depend on the chat mode and are enforced by
            // the submission handler after it loads the chat.
            return;
        }
        if (!"TEXT".equals(input.type()) && !"STICKER".equals(input.type())) {
            throw DomainException.badRequest("type must be TEXT or STICKER",
                    Map.of("field", "type", "allowed", "TEXT,STICKER"));
        }
        if (input.isSticker()) {
            requireValidStickerPayload(input);
            return;
        }
        // TEXT must not smuggle a sticker reference: the payload variants are exclusive.
        if (input.hasSticker()) {
            throw new InvalidStickerMessageException("mixed_sticker_payload",
                    Map.of("allowed_type", "STICKER"));
        }
        if (input.attachmentIds().size() > 10) {
            throw DomainException.unprocessable(ErrorCode.TOO_MANY_FILES,
                    "A message can carry at most 10 attachments",
                    Map.of("limit", 10, "actual", input.attachmentIds().size()));
        }
        // An empty managed payload is rejected after the handler knows the chat mode: in
        // an E2EE chat the same body must answer 422 ENVELOPES_REQUIRED, not 400.
    }

    private static void requireValidStickerPayload(MessageCreateInput input) {
        if (input.stickerId() == null) {
            throw new InvalidStickerMessageException("missing_sticker_id", Map.of());
        }
        if (input.hasText()) {
            throw new InvalidStickerMessageException("text_not_allowed", Map.of());
        }
        if (input.hasAttachments()) {
            throw new InvalidStickerMessageException("attachments_not_allowed",
                    Map.of("field", "attachment_ids"));
        }
    }

    private byte[] requestHash(SendMessageCommand command, EnvelopeBatch envelopes) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("client_message_id", command.input().clientMessageId());
        canonical.put("type", command.input().type());
        canonical.put("text", command.input().text());
        // Only STICKER carries a sticker_id; keeping TEXT hashes unchanged preserves
        // idempotency replays for requests issued before the E5-B deployment.
        if (command.input().isSticker()) {
            canonical.put("sticker_id", command.input().stickerId());
        }
        canonical.put("reply_to_id", command.input().replyToId());
        canonical.put("attachment_ids", command.input().attachmentIds());
        if (envelopes.present()) {
            // Deterministic fingerprint instead of the parsed JSON text: field order and
            // whitespace must not create a second idempotency identity for the same bytes.
            canonical.put("envelopes", EnvelopeFingerprint.of(envelopes.envelopes()));
        }
        String body = canonicalizer.canonicalize(canonical);
        return canonicalizer.sha256("POST\n/api/v1/chats/" + command.chatId()
                + "/messages\n" + body);
    }

    private MessageView lookupExistingQuietly(SendMessageCommand command) {
        if (command.input().clientMessageId() == null) {
            return null;
        }
        try {
            return queryHandler.findByClientMessageId(command.principal(), command.chatId(),
                    command.input().clientMessageId());
        } catch (RuntimeException ex) {
            log.warn("Could not check client_message_id after send failure request_id={}",
                    command.principal().requestId());
            return null;
        }
    }

    private boolean anotherSenderUsedClientMessageId(SendMessageCommand command) {
        if (command.input().clientMessageId() == null
                || command.principal().workspaceId() == null) {
            return false;
        }
        try {
            return queryHandler.senderIdForClientMessageId(command.principal(),
                    command.chatId(), command.input().clientMessageId()) != null;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    private boolean sameContent(SendMessageCommand command, MessageView existing,
                                EnvelopeBatch envelopes) {
        MessageCreateInput input = command.input();
        if ("E2EE_PAIRWISE".equals(existing.cryptoScheme())) {
            if (!envelopes.present()) {
                return false;
            }
            return EnvelopeFingerprint.of(storedEnvelopes(command, existing.id())).equals(
                    EnvelopeFingerprint.of(envelopes.envelopes()));
        }
        if (input.isSticker()) {
            return "STICKER".equals(existing.type())
                    && Objects.equals(existing.stickerId(), input.stickerId())
                    && Objects.equals(existing.replyToId(), input.replyToId());
        }
        return "TEXT".equals(existing.type())
                && Objects.equals(existing.text(), input.text())
                && Objects.equals(existing.replyToId(), input.replyToId())
                && Objects.equals(existing.attachments().stream()
                        .map(attachment -> attachment.id()).sorted().toList(),
                        input.attachmentIds().stream().sorted().toList());
    }

    private EnvelopeCoverageView replayCoverage(SendMessageCommand command, MessageView existing,
                                                EnvelopeBatch envelopes) {
        if (!"E2EE_PAIRWISE".equals(existing.cryptoScheme()) || !envelopes.present()) {
            return null;
        }
        // Fail closed: if coverage cannot be rebuilt, do not answer 201 without it
        // (D-S4-04). The read-only service owns the tenant context and its own transaction.
        return replayCoverageService.replayCoverage(command.principal(), existing.chatId(),
                envelopes.envelopes());
    }

    private java.util.List<CryptoEnvelope> storedEnvelopes(SendMessageCommand command,
                                                            UUID messageId) {
        try {
            return queryHandler.envelopesOf(command.principal(), command.chatId(), messageId);
        } catch (RuntimeException ex) {
            return java.util.List.of();
        }
    }

    private static DomainException clientMessageIdConflict(UUID clientMessageId) {
        return DomainException.conflict(ErrorCode.CLIENT_MESSAGE_ID_CONFLICT,
                "client_message_id was already used with a different message",
                Map.of("client_message_id", String.valueOf(clientMessageId)));
    }

    private void completeQuietly(SendMessageCommand command, byte[] requestHash, UUID messageId) {
        try {
            idempotency.complete(command.principal(), SendMessageCommand.IDEMPOTENCY_SCOPE,
                    command.idempotencyKey().toString(), requestHash, 201, messageId);
        } catch (RuntimeException ex) {
            log.warn("Could not complete idempotency after client_message_id replay request_id={}",
                    command.principal().requestId());
        }
    }
}
