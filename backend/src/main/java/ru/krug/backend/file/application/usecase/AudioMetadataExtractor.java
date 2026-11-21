package ru.krug.backend.file.application.usecase;

import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.file.application.model.ServerAudioMedia;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.model.AudioMetadata;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.MediaMetadataSource;
import ru.krug.backend.file.domain.service.AudioArtworkKey;
import ru.krug.backend.file.domain.service.AudioFileTypes;
import ru.krug.backend.file.domain.service.AudioMetadataParser;

/**
 * Server-side fallback for audio metadata (#97).
 *
 * <p>Runs only for MANAGED audio uploads. The bytes are read through the storage port with
 * hard caps inside {@link AudioMetadataParser}; the parser never performs network I/O, never
 * decompresses anything and never trusts a declared length for allocation. Extracted cover
 * bytes are re-validated as a static raster and written to the same private bucket under a
 * server-generated key.
 *
 * <p>Client metadata is preserved when it is complete: the server only fills a missing or
 * empty payload ({@code media == null}, {@code metadata_source=NONE}, or an AUDIO object with
 * no fields/duration). A voice take ({@code audio/webm}/{@code audio/ogg}) is never parsed.
 */
@Service
public class AudioMetadataExtractor {

    private static final Logger log = LoggerFactory.getLogger(AudioMetadataExtractor.class);
    private static final String ARTWORK_PATH = "/api/v1/attachments/";

    private final ObjectStoragePort storage;
    private final FileSettingsPort settings;

    public AudioMetadataExtractor(ObjectStoragePort storage, FileSettingsPort settings) {
        this.storage = storage;
        this.settings = settings;
    }

    /** True when the upload is an audio file the server may inspect. */
    public boolean isAudio(String mime, String filename) {
        return AudioFileTypes.isAudio(mime, filename) && !AudioFileTypes.isVoice(mime, filename);
    }

    /**
     * A complete client payload wins. An absent payload, {@code NONE}, a non-AUDIO kind or an
     * AUDIO object with no usable fields is replaced by server extraction.
     */
    public boolean needsServerMetadata(MediaMetadata client) {
        if (client == null) {
            return true;
        }
        if (client.kind() != MediaKind.AUDIO) {
            return true;
        }
        if (client.metadataSource() == MediaMetadataSource.NONE) {
            return true;
        }
        return client.title() == null && client.artist() == null && client.album() == null
                && client.year() == null && client.genre() == null
                && client.durationMs() == null;
    }

    /**
     * Parses the stored object and stores its cover. Never throws for malformed media: the
     * upload keeps its regular pipeline and simply gets an AUDIO/SERVER object without fields.
     */
    public ServerAudioMedia extract(UUID workspaceId, UUID attachmentId, String mime,
                                    String filename, String objectKey, long sizeBytes) {
        AudioMetadata parsed = AudioMetadata.empty();
        try (InputStream input = storage.open(objectKey)) {
            parsed = AudioMetadataParser.parse(input, sizeBytes);
        } catch (IOException | RuntimeException ex) {
            log.warn("file.audio.parse_failed attachment_id={}", attachmentId);
        }

        String artworkKey = null;
        String artworkUrl = null;
        AudioMetadata.Artwork artwork = parsed.artwork();
        if (artwork != null) {
            try {
                String key = AudioArtworkKey.forAttachment(workspaceId, attachmentId);
                storage.putObject(key, artwork.bytes(), artwork.mimeType());
                artworkKey = key;
                artworkUrl = artworkUrl(attachmentId);
            } catch (RuntimeException ex) {
                // A cover is best-effort; the metadata itself must not fail the upload.
                log.warn("file.audio.artwork_store_failed attachment_id={}", attachmentId);
            }
        }

        MediaMetadata media;
        try {
            media = MediaMetadata.serverAudio(parsed.durationMs(), parsed.title(),
                    parsed.artist(), parsed.album(), parsed.year(), parsed.genre(), artworkUrl);
        } catch (RuntimeException ex) {
            // A misconfigured artwork origin must not discard otherwise valid tags.
            log.warn("file.audio.metadata_rejected attachment_id={}", attachmentId);
            try {
                media = MediaMetadata.serverAudio(parsed.durationMs(), parsed.title(),
                        parsed.artist(), parsed.album(), parsed.year(), parsed.genre(), null);
            } catch (RuntimeException ignored) {
                media = MediaMetadata.serverAudio(null, null, null, null, null, null, null);
            }
        }
        return new ServerAudioMedia(media, artworkKey);
    }

    private String artworkUrl(UUID attachmentId) {
        String base = settings.artworkBaseUrl();
        if (base == null || base.isBlank()) {
            return null;
        }
        String origin = base.strip();
        while (origin.endsWith("/")) {
            origin = origin.substring(0, origin.length() - 1);
        }
        if (origin.isEmpty()) {
            return null;
        }
        String url = origin + ARTWORK_PATH + attachmentId + "/artwork";
        return url.length() <= MediaMetadata.MAX_ARTWORK_URL_LENGTH ? url : null;
    }
}
