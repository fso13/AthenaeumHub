package ru.krug.backend.plugin.infrastructure.adapter;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.model.FileCenterRow;
import ru.krug.backend.file.application.port.FileCenterQueryPort;
import ru.krug.backend.file.application.port.FileCenterQueryPort.FileCenterQuery;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.plugin.application.model.MusicRoomTrackView;
import ru.krug.backend.plugin.application.port.MusicRoomTrackPort;

/**
 * File-center backed adapter for the music-room audio list (#94). Reusing the existing
 * file-center query keeps the authorization rules in one place: the caller must be an
 * ACTIVE chat member, E2EE chats/messages and deleted/for-me-hidden messages are excluded
 * in SQL, and only metadata columns are selected (no object key, hash or presigned URL).
 *
 * <p>Only {@code CLEAN} audio is listed: a pending or quarantined attachment is never
 * offered to the player.</p>
 */
@Component
public class MusicRoomTrackAdapter implements MusicRoomTrackPort {

    private final FileCenterQueryPort fileCenter;

    public MusicRoomTrackAdapter(FileCenterQueryPort fileCenter) {
        this.fileCenter = fileCenter;
    }

    @Override
    public List<MusicRoomTrackView> findAudio(UUID workspaceId, UUID userId, UUID chatId,
                                              int fetchLimit) {
        List<FileCenterRow> rows = fileCenter.findPage(new FileCenterQuery(
                workspaceId, userId, chatId, MediaKind.AUDIO.name(), ScanStatus.CLEAN.name(),
                null, null, null, null, null, fetchLimit));
        return rows.stream().map(MusicRoomTrackAdapter::toView).toList();
    }

    private static MusicRoomTrackView toView(FileCenterRow row) {
        return new MusicRoomTrackView(
                row.id(),
                row.messageId(),
                row.filename(),
                row.mimeType(),
                row.media() == null ? null : row.media().durationMs(),
                row.media() == null ? null : row.media().artworkUrl(),
                row.media() == null ? null : row.media().title(),
                row.media() == null ? null : row.media().artist(),
                row.sizeBytes(),
                row.createdAt());
    }
}
