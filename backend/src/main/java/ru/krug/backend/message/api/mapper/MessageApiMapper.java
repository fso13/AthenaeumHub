package ru.krug.backend.message.api.mapper;

import java.util.List;

import ru.krug.backend.message.api.dto.AttachmentRefResponse;
import ru.krug.backend.message.api.dto.EnvelopeCoverageResponse;
import ru.krug.backend.message.api.dto.MessagePageInfo;
import ru.krug.backend.message.api.dto.MessagePageResponse;
import ru.krug.backend.message.api.dto.MessageResponse;
import ru.krug.backend.message.api.dto.MessageStickerResponse;
import ru.krug.backend.message.application.model.EnvelopeCoverageView;
import ru.krug.backend.message.application.model.MessagePageView;
import ru.krug.backend.message.application.model.MessageStickerView;
import ru.krug.backend.message.application.model.MessageView;

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
                        attachment.scanStatus()))
                .toList();
        return new MessageResponse(view.id(), view.chatId(), view.seq(), view.type(),
                view.senderId(), view.senderDisplayName(), view.text(), view.replyToId(),
                view.createdAt(), view.editedAt(), view.deletedAt(), view.version(),
                view.clientMessageId(), view.crypto(), view.stickerId(), sticker(view.sticker()),
                attachments, coverage(coverage));
    }

    public static MessagePageResponse toResponse(MessagePageView view) {
        List<MessageResponse> items = view.items().stream()
                .map(MessageApiMapper::toResponse)
                .toList();
        return new MessagePageResponse(items,
                new MessagePageInfo(view.nextCursor(), view.hasMore()));
    }

    private static EnvelopeCoverageResponse coverage(EnvelopeCoverageView coverage) {
        if (coverage == null) {
            return null;
        }
        return new EnvelopeCoverageResponse(coverage.devices(), coverage.covered(),
                coverage.peerDevices(), coverage.peerCovered(), coverage.selfDevices(),
                coverage.selfCovered(), coverage.uncoveredDeviceIds(), coverage.warning());
    }

    private static MessageStickerResponse sticker(MessageStickerView sticker) {
        if (sticker == null) {
            return null;
        }
        return new MessageStickerResponse(sticker.id(), sticker.packId(), sticker.alt(),
                sticker.url(), sticker.favorite());
    }
}
