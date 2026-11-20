package ru.krug.backend.realtime.application.service;

import java.util.UUID;

import ru.krug.backend.message.application.model.AttachmentMediaView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.realtime.application.model.AttachmentMediaSnapshot;
import ru.krug.backend.realtime.application.model.AttachmentSnapshot;
import ru.krug.backend.realtime.application.model.MessageSnapshot;
import ru.krug.backend.realtime.application.model.StickerSnapshot;

/**
 * Application read model -> realtime snapshot. Shared by the created and updated fan-out
 * paths so both frames carry exactly the same {@code Message} shape (including reactions).
 */
public final class MessageSnapshotMapper {

    private MessageSnapshotMapper() {
    }

    public static MessageSnapshot from(UUID workspaceId, MessageView view) {
        return new MessageSnapshot(workspaceId,
                view.id(), view.chatId(), view.seq(), view.type(), view.senderId(),
                view.senderDisplayName(), view.text(), view.replyToId(), view.threadRootId(),
                view.createdAt(), view.editedAt(), view.deletedAt(), view.version(),
                view.clientMessageId(), view.crypto(), view.stickerId(),
                view.sticker() == null ? null : new StickerSnapshot(view.sticker().id(),
                        view.sticker().packId(), view.sticker().alt(), view.sticker().url(),
                        view.sticker().favorite()),
                view.attachments().stream()
                        .map(attachment -> new AttachmentSnapshot(attachment.id(),
                                attachment.filename(), attachment.sizeBytes(),
                                attachment.mimeType(), attachment.scanStatus(),
                                media(attachment.media())))
                        .toList(),
                view.reactions(), view.pluginContent());
    }

    private static AttachmentMediaSnapshot media(AttachmentMediaView media) {
        if (media == null) {
            return null;
        }
        return new AttachmentMediaSnapshot(media.kind(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource());
    }
}
