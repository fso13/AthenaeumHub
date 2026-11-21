package ru.krug.backend.message.api.mapper;

import java.util.List;

import ru.krug.backend.message.api.dto.AttachmentMediaResponse;
import ru.krug.backend.message.api.dto.AttachmentRefResponse;
import ru.krug.backend.message.api.dto.EnvelopeCoverageResponse;
import ru.krug.backend.message.api.dto.MessagePageInfo;
import ru.krug.backend.message.api.dto.MessagePageResponse;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.dto.MessagePollOptionResponse;
import ru.krug.backend.message.api.dto.MessagePollResponse;
import ru.krug.backend.message.api.dto.MessageStickerResponse;
import ru.krug.backend.message.api.dto.MessageTaskResponse;
import ru.krug.backend.message.api.dto.ReactionSummaryResponse;
import ru.krug.backend.message.api.dto.ThreadSummaryResponse;
import ru.krug.backend.message.application.model.AttachmentMediaView;
import ru.krug.backend.message.application.model.EnvelopeCoverageView;
import ru.krug.backend.message.application.model.MessagePageView;
import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
import ru.krug.backend.message.application.model.MessageStickerView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.model.ThreadSummaryView;

/**
 * Application result/read model -> API DTO. No domain imports in the API layer.
 */
public final class MessageApiMapper {

    private MessageApiMapper() {
    }

    public static MessageResponse toResponse(MessageView view) {
        return toResponse(view, null);
    }

    /**
     * E2EE create/replay must always carry {@code envelope_coverage} (D-S4-04). Failing
     * closed here turns a coverage computation bug into a 5xx instead of a schema-invalid
     * 201 that the client is required to reject.
     */
    public static MessageResponse toCreateResponse(MessageView view,
                                                    EnvelopeCoverageView coverage) {
        if (view.isE2ee() && coverage == null) {
            throw new IllegalStateException("E2EE response requires envelope_coverage");
        }
        return toResponse(view, coverage);
    }

    public static MessageResponse toResponse(MessageView view, EnvelopeCoverageView coverage) {
        List<AttachmentRefResponse> attachments = view.attachments().stream()
                .map(attachment -> new AttachmentRefResponse(attachment.id(),
                        attachment.filename(), attachment.sizeBytes(), attachment.mimeType(),
                        attachment.scanStatus(), media(attachment.media())))
                .toList();
        List<ReactionSummaryResponse> reactions = view.reactions().stream()
                .map(reaction -> new ReactionSummaryResponse(reaction.emoji(),
                        reaction.count(), reaction.me()))
                .toList();
        return new MessageResponse(view.id(), view.chatId(), view.seq(), view.type(),
                view.senderId(), view.senderDisplayName(), view.senderType(), view.botId(),
                view.text(), view.replyToId(),
                view.threadRootId(), view.createdAt(), view.editedAt(), view.deletedAt(),
                view.version(), view.clientMessageId(), view.crypto(), view.stickerId(),
                sticker(view.sticker()), attachments, reactions,
                summary(view.threadSummary()), coverage(coverage),
                view.pluginContent() == null ? null : view.pluginContent().pollId(),
                poll(view.pluginContent() == null ? null : view.pluginContent().poll()),
                view.pluginContent() == null ? null : view.pluginContent().taskId(),
                task(view.pluginContent() == null ? null : view.pluginContent().task()),
                view.mentions(), view.mentionAll());
    }

    public static MessagePageResponse toResponse(MessagePageView view) {
        List<MessageResponse> items = view.items().stream()
                .map(MessageApiMapper::toResponse)
                .toList();
        return new MessagePageResponse(items,
                new MessagePageInfo(view.nextCursor(), view.hasMore()));
    }

    private static AttachmentMediaResponse media(AttachmentMediaView media) {
        if (media == null) {
            return null;
        }
        return new AttachmentMediaResponse(media.kind(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource());
    }

    private static EnvelopeCoverageResponse coverage(EnvelopeCoverageView coverage) {
        if (coverage == null) {
            return null;
        }
        return new EnvelopeCoverageResponse(coverage.devices(), coverage.covered(),
                coverage.peerDevices(), coverage.peerCovered(), coverage.selfDevices(),
                coverage.selfCovered(), coverage.uncoveredDeviceIds(), coverage.warning());
    }

    private static MessagePollResponse poll(EmbeddedPollView poll) {
        if (poll == null) {
            return null;
        }
        return new MessagePollResponse(poll.id(), poll.question(),
                poll.options().stream()
                        .map(option -> new MessagePollOptionResponse(option.id(), option.text(),
                                option.position(), option.votes()))
                        .toList(),
                poll.creatorId(), poll.closed(), poll.closedAt(), poll.createdAt(),
                poll.myOptionId(), poll.totalVotes());
    }

    private static MessageTaskResponse task(EmbeddedTaskView task) {
        if (task == null) {
            return null;
        }
        return new MessageTaskResponse(task.id(), task.title(), task.creatorId(),
                task.assigneeId(), task.dueAt(), task.done(), task.completedBy(),
                task.completedAt(), task.createdAt());
    }

    private static MessageStickerResponse sticker(MessageStickerView sticker) {
        if (sticker == null) {
            return null;
        }
        return new MessageStickerResponse(sticker.id(), sticker.packId(), sticker.alt(),
                sticker.url(), sticker.favorite());
    }

    private static ThreadSummaryResponse summary(ThreadSummaryView summary) {
        if (summary == null) {
            return null;
        }
        return new ThreadSummaryResponse(summary.replyCount(), summary.lastReplyAt(),
                summary.lastReplyAuthorId(), summary.lastReplyExcerpt());
    }
}
