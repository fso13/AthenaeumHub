package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
import ru.krug.backend.message.application.model.MessageAttachmentView;
import ru.krug.backend.message.application.model.MessagePluginContent;
import ru.krug.backend.message.application.model.ReactionSummaryView;
import ru.krug.backend.message.application.port.MessageAttachmentPort;
import ru.krug.backend.message.application.port.MessageDeviceDirectoryPort;
import ru.krug.backend.message.application.port.MessagePluginContentPort;
import ru.krug.backend.message.application.service.EnvelopeWireMapper;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.message.domain.repository.MessageReactionRepository;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.realtime.application.model.AttachmentMediaSnapshot;
import ru.krug.backend.realtime.application.model.AttachmentSnapshot;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.StickerSnapshot;
import ru.krug.backend.realtime.application.port.RealtimeChatHistoryPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.sticker.application.model.StickerRefView;
import ru.krug.backend.sticker.application.port.StickerCatalogPort;

/**
 * Bounded replay read: {@code seq > afterSeq} in ASC order, limit enforced by the message
 * repository. Runs in its own read-only transaction with the tenant GUCs required by RLS.
 * E2EE rows are returned without plaintext; only the envelope addressed to the connection's
 * device is attached.
 */
@Component
public class RealtimeChatHistoryAdapter implements RealtimeChatHistoryPort {

    private final MessageRepository messageRepository;
    private final MessageEnvelopeRepository envelopeRepository;
    private final MessageReactionRepository reactionRepository;
    private final MessageAttachmentPort attachmentPort;
    private final StickerCatalogPort stickerCatalog;
    private final TenantContext tenantContext;
    private final MessageDeviceDirectoryPort deviceDirectory;
    private final E2eeSettingsPort e2eeSettings;
    private final MessagePluginContentPort pluginContent;

    public RealtimeChatHistoryAdapter(MessageRepository messageRepository,
                                      MessageEnvelopeRepository envelopeRepository,
                                      MessageReactionRepository reactionRepository,
                                      MessageAttachmentPort attachmentPort,
                                      StickerCatalogPort stickerCatalog,
                                      TenantContext tenantContext,
                                      MessageDeviceDirectoryPort deviceDirectory,
                                      E2eeSettingsPort e2eeSettings,
                                      MessagePluginContentPort pluginContent) {
        this.messageRepository = messageRepository;
        this.envelopeRepository = envelopeRepository;
        this.reactionRepository = reactionRepository;
        this.attachmentPort = attachmentPort;
        this.stickerCatalog = stickerCatalog;
        this.tenantContext = tenantContext;
        this.deviceDirectory = deviceDirectory;
        this.e2eeSettings = e2eeSettings;
        this.pluginContent = pluginContent;
    }

    @Override
    @Transactional(readOnly = true)
    public List<MessageSnapshot> after(UUID workspaceId, UUID chatId, UUID userId, UUID deviceId,
                                       long afterSeq, int limit) {
        tenantContext.activate(new Principal(userId, deviceId, workspaceId, "realtime-replay"));
        List<Message> rows = messageRepository.findPage(workspaceId, chatId, afterSeq, null,
                userId, limit);
        // P2-03: the kill-switch also covers WS replay. With the flag off an already stored
        // E2EE message is neither replayed nor accompanied by an envelope, matching the
        // REST 409 E2EE_DISABLED. Managed messages are unaffected.
        boolean e2eeEnabled = e2eeSettings.enabled();
        List<Message> messages = e2eeEnabled ? rows
                : rows.stream().filter(message -> !message.isE2ee()).toList();
        Map<UUID, List<MessageAttachmentView>> attachments = attachmentPort.findByMessageIds(
                workspaceId, messages.stream().map(Message::id).toList());
        Map<UUID, StickerRefView> stickers = stickerCatalog.findForMessage(userId,
                messageStickerIds(messages));
        Map<UUID, List<ReactionSummaryView>> reactions = reactionView(
                reactionRepository.summarize(workspaceId,
                        messages.stream().filter(message -> !message.isE2ee())
                                .map(Message::id).toList(), userId));
        // P0-01 defense-in-depth: only an ACTIVE device of the authenticated user may
        // resolve an envelope; otherwise every frame gets crypto:null.
        boolean deviceValid = e2eeEnabled && deviceId != null
                && deviceDirectory.findDevice(deviceId)
                        .filter(device -> device.active() && userId.equals(device.userId()))
                        .isPresent();
        Map<UUID, MessageEnvelope> crypto = deviceValid
                ? envelopeRepository.findForDevice(workspaceId,
                        messages.stream().filter(Message::isE2ee).map(Message::id).toList(),
                        deviceId)
                : Map.of();
        // #95: one bounded query per kind for the whole replay window. Deleted messages keep
        // their ids in the row but the frame is a tombstone, so their content is dropped.
        List<UUID> pollIds = messages.stream().map(Message::pollId)
                .filter(java.util.Objects::nonNull).distinct().toList();
        List<UUID> taskIds = messages.stream().map(Message::taskId)
                .filter(java.util.Objects::nonNull).distinct().toList();
        Map<UUID, EmbeddedPollView> polls = pollIds.isEmpty() ? Map.of()
                : pluginContent.findPolls(workspaceId, chatId, pollIds, userId);
        Map<UUID, EmbeddedTaskView> tasks = taskIds.isEmpty() ? Map.of()
                : pluginContent.findTasks(workspaceId, chatId, taskIds, userId);
        return messages.stream()
                .map(message -> snapshot(message,
                        attachments.getOrDefault(message.id(), List.of()),
                        message.stickerId() == null ? null : stickers.get(message.stickerId()),
                        crypto.get(message.id()),
                        reactions.getOrDefault(message.id(), List.of()),
                        (message.deletedAt() != null
                                || (message.pollId() == null && message.taskId() == null))
                                ? null
                                : new MessagePluginContent(message.pollId(),
                                        message.pollId() == null ? null
                                                : polls.get(message.pollId()),
                                        message.taskId(),
                                        message.taskId() == null ? null
                                                : tasks.get(message.taskId()))))
                .toList();
    }

    private static List<UUID> messageStickerIds(List<Message> messages) {
        return messages.stream()
                .map(Message::stickerId)
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
    }

    private static MessageSnapshot snapshot(Message message,
                                            List<MessageAttachmentView> attachments,
                                            StickerRefView sticker,
                                            MessageEnvelope envelope,
                                            List<ReactionSummaryView> reactions,
                                            MessagePluginContent pluginContent) {
        Object crypto = envelope == null || message.deletedAt() != null ? null
                : EnvelopeWireMapper.toWire(envelope.envelope());
        boolean deleted = message.deletedAt() != null;
        return new MessageSnapshot(message.workspaceId(), message.id(), message.chatId(),
                message.seq(), message.type().name(), message.senderId(),
                message.senderDisplayName(), message.senderType().name(), message.botId(),
                deleted || message.body() == null ? null
                        : message.body().value(), message.replyToId(), message.threadRootId(),
                message.createdAt(), message.editedAt(), message.deletedAt(), message.version(),
                message.clientMessageId(), crypto, deleted ? null : message.stickerId(),
                deleted || sticker == null ? null
                        : new StickerSnapshot(sticker.id(), sticker.packId(),
                                sticker.alt(), sticker.url(), sticker.favorite()),
                deleted ? List.of() : attachments.stream()
                        .map(attachment -> new AttachmentSnapshot(attachment.id(),
                                attachment.filename(), attachment.sizeBytes(),
                                attachment.mimeType(), attachment.scanStatus(),
                                media(attachment.media())))
                        .toList(),
                deleted ? List.of() : reactions, deleted ? null : pluginContent);
    }

    private static Map<UUID, List<ReactionSummaryView>> reactionView(
            Map<UUID, List<ru.krug.backend.message.domain.model.MessageReaction>> rows) {
        Map<UUID, List<ReactionSummaryView>> result = new LinkedHashMap<>();
        rows.forEach((messageId, reactions) -> result.put(messageId, reactions.stream()
                .map(reaction -> new ReactionSummaryView(reaction.emoji(), reaction.count(),
                        reaction.me()))
                .toList()));
        return result;
    }

    private static AttachmentMediaSnapshot media(
            ru.krug.backend.message.application.model.AttachmentMediaView media) {
        if (media == null) {
            return null;
        }
        return new AttachmentMediaSnapshot(media.kind(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource());
    }
}
