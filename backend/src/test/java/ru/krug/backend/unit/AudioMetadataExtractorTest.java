package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.ByteArrayInputStream;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.file.application.model.ServerAudioMedia;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.usecase.AudioMetadataExtractor;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.MediaMetadataSource;
import ru.krug.backend.file.domain.service.AudioArtworkKey;
import ru.krug.backend.support.AudioTestData;

/**
 * #97: fallback decision, private artwork storage and graceful degradation. The extractor
 * never parses complete client metadata and never lets a broken object fail an upload.
 */
class AudioMetadataExtractorTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID ATTACHMENT = UUID.randomUUID();

    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final FileSettingsPort settings = mock(FileSettingsPort.class);
    private AudioMetadataExtractor extractor;

    @BeforeEach
    void setUp() {
        extractor = new AudioMetadataExtractor(storage, settings);
        when(settings.artworkBaseUrl()).thenReturn("https://chat.example.com/");
    }

    @Test
    void completeClientMetadataIsNotReplaced() {
        MediaMetadata client = MediaMetadata.sanitize("AUDIO", 2_000L, null, null,
                "Client title", "Client artist", null, null, null, null, "ID3");

        assertThat(extractor.needsServerMetadata(client)).isFalse();
        assertThat(extractor.needsServerMetadata(null)).isTrue();
        assertThat(extractor.needsServerMetadata(MediaMetadata.sanitize("AUDIO", null, null,
                null, "Only title", null, null, null, null, null, "ID3"))).isFalse();
        assertThat(extractor.needsServerMetadata(MediaMetadata.sanitize("AUDIO", null, null,
                null, null, null, null, null, null, null, "NONE"))).isTrue();
        assertThat(extractor.needsServerMetadata(MediaMetadata.sanitize("FILE", null, null,
                null, null, null, null, null, null, null, "ID3"))).isTrue();
    }

    @Test
    void extractsMissingMetadataAndStoresTheCoverPrivately() {
        byte[] artwork = AudioTestData.jpegArtwork();
        byte[] object = AudioTestData.mp3Id3v23("Server title", "Server artist", "Album",
                "2024", "Rock", artwork);
        when(storage.open("file-key")).thenReturn(new ByteArrayInputStream(object));

        ServerAudioMedia result = extractor.extract(WORKSPACE, ATTACHMENT, "audio/mpeg",
                "song.mp3", "file-key", object.length);

        assertThat(result.media().kind()).isEqualTo(MediaKind.AUDIO);
        assertThat(result.media().metadataSource()).isEqualTo(MediaMetadataSource.SERVER);
        assertThat(result.media().title()).isEqualTo("Server title");
        assertThat(result.media().artist()).isEqualTo("Server artist");
        assertThat(result.media().durationMs()).isPositive();
        String key = AudioArtworkKey.forAttachment(WORKSPACE, ATTACHMENT);
        assertThat(result.artworkKey()).isEqualTo(key);
        assertThat(result.media().artworkUrl())
                .isEqualTo("https://chat.example.com/api/v1/attachments/" + ATTACHMENT
                        + "/artwork");
        verify(storage).putObject(key, artwork, "image/jpeg");
    }

    @Test
    void noAdvertisedArtworkUrlWhenTheOriginIsBlank() {
        when(settings.artworkBaseUrl()).thenReturn("");
        byte[] object = AudioTestData.mp3Id3v23("Title", null, null, null, null,
                AudioTestData.pngArtwork());
        when(storage.open("file-key")).thenReturn(new ByteArrayInputStream(object));

        ServerAudioMedia result = extractor.extract(WORKSPACE, ATTACHMENT, "audio/mpeg",
                "song.mp3", "file-key", object.length);

        assertThat(result.media().artworkUrl()).isNull();
        assertThat(result.artworkKey()).isNotNull();
        verify(storage).putObject(anyString(), any(), anyString());
    }

    @Test
    void voiceTakesAreNeverInspected() {
        assertThat(extractor.isAudio("audio/webm", "voice.webm")).isFalse();
        assertThat(extractor.isAudio("audio/ogg", "voice.ogg")).isFalse();
        assertThat(extractor.isAudio("audio/mpeg", "song.mp3")).isTrue();
        assertThat(extractor.isAudio("application/octet-stream", "song.m4a")).isTrue();
        verify(storage, never()).open(anyString());
    }

    @Test
    void storageFailureStillProducesAnAudioServerFallback() {
        when(storage.open("file-key")).thenThrow(new RuntimeException("store unavailable"));

        ServerAudioMedia result = extractor.extract(WORKSPACE, ATTACHMENT, "audio/mpeg",
                "song.mp3", "file-key", 4_096);

        assertThat(result.media().kind()).isEqualTo(MediaKind.AUDIO);
        assertThat(result.media().metadataSource()).isEqualTo(MediaMetadataSource.SERVER);
        assertThat(result.media().title()).isNull();
        assertThat(result.media().durationMs()).isNull();
        assertThat(result.artworkKey()).isNull();
    }
}
