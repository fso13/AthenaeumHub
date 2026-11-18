package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.exception.MediaMetadataInvalidException;
import ru.krug.backend.file.domain.exception.UnsupportedFileTypeException;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.MediaMetadataSource;
import ru.krug.backend.shared.error.DomainException;

/**
 * D1-BE2 unit coverage for the media value object: sanitization, strict bounds, safe
 * artwork policy, voice MIME allowlist and tolerant persistence mapping.
 */
class MediaMetadataTest {

    @Test
    void sanitizesTrimsAndRoundTripsThroughJsonbMap() {
        MediaMetadata media = MediaMetadata.sanitize(" AUDIO ", 245_000L, 640, 480,
                "  Song title  ", " Artist ", " Album ", "2024", " Rock ",
                " https://cdn.example.com/art/cover.jpg ", " id3 ");

        assertThat(media.kind()).isEqualTo(MediaKind.AUDIO);
        assertThat(media.metadataSource()).isEqualTo(MediaMetadataSource.ID3);
        assertThat(media.title()).isEqualTo("Song title");
        assertThat(media.artist()).isEqualTo("Artist");
        assertThat(media.album()).isEqualTo("Album");
        assertThat(media.genre()).isEqualTo("Rock");
        assertThat(media.artworkUrl()).isEqualTo("https://cdn.example.com/art/cover.jpg");

        Map<String, Object> json = media.toMap();
        assertThat(json).containsEntry("kind", "AUDIO")
                .containsEntry("metadata_source", "ID3")
                .containsEntry("duration_ms", 245_000L)
                .containsEntry("width", 640)
                .containsEntry("height", 480);
        assertThat(MediaMetadata.fromMap(json)).isEqualTo(media);
    }

    @Test
    void blankOptionalStringsBecomeNull() {
        MediaMetadata media = MediaMetadata.sanitize("FILE", null, null, null, "   ", "", null,
                null, " ", null, "NONE");
        assertThat(media.title()).isNull();
        assertThat(media.artist()).isNull();
        assertThat(media.album()).isNull();
        assertThat(media.genre()).isNull();
        assertThat(media.artworkUrl()).isNull();
        assertThat(media.toMap()).doesNotContainKeys("title", "artist", "album", "genre",
                "artwork_url", "duration_ms", "width", "height");
    }

    @Test
    void rejectsUnknownRequiredEnums() {
        assertInvalid(() -> MediaMetadata.sanitize(null, null, null, null, null, null, null,
                null, null, null, "NONE"), "media.kind");
        assertInvalid(() -> MediaMetadata.sanitize("BOGUS", null, null, null, null, null, null,
                null, null, null, "NONE"), "media.kind");
        assertInvalid(() -> MediaMetadata.sanitize("FILE", null, null, null, null, null, null,
                null, null, null, null), "media.metadata_source");
        assertInvalid(() -> MediaMetadata.sanitize("FILE", null, null, null, null, null, null,
                null, null, null, "TRUST_ME"), "media.metadata_source");
    }

    @Test
    void rejectsOutOfBoundsDurationAndDimensions() {
        assertThatThrownBy(() -> MediaMetadata.sanitize("AUDIO", -1L, null, null, null, null,
                null, null, null, null, "CLIENT"))
                .isInstanceOf(MediaMetadataInvalidException.class)
                .hasMessage("Media metadata is invalid")
                .extracting(error -> ((DomainException) error).details().get("reason"))
                .isEqualTo("out_of_range");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", MediaMetadata.MAX_DURATION_MS + 1,
                null, null, null, null, null, null, null, null, "CLIENT"),
                "media.duration_ms");
        assertInvalid(() -> MediaMetadata.sanitize("IMAGE", null, 0, 100, null, null, null,
                null, null, null, "CLIENT"), "media.width");
        assertInvalid(() -> MediaMetadata.sanitize("IMAGE", null, 100,
                MediaMetadata.MAX_DIMENSION + 1, null, null, null, null, null, null, "CLIENT"),
                "media.height");
    }

    @Test
    void rejectsHtmlControlBidiAndOversizedStrings() {
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null,
                "<script>alert(1)</script>", null, null, null, null, null, "ID3"), "media.title");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null,
                "bad\u0000artist", null, null, null, null, "ID3"), "media.artist");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null,
                "rtl\u202Eoverride", null, null, null, "ID3"), "media.album");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null, null,
                "2024", "x".repeat(MediaMetadata.MAX_GENRE_LENGTH + 1), null, "ID3"),
                "media.genre");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null,
                "x".repeat(MediaMetadata.MAX_TITLE_LENGTH + 1), null, null, null, null, null,
                "ID3"), "media.title");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null, null,
                "24", null, null, "ID3"), "media.year");
    }

    @Test
    void artworkPolicyAllowsOnlySafeAbsoluteHttpUrls() {
        assertThat(MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null, null, null,
                null, "http://example.com/a.png", "ID3").artworkUrl())
                .isEqualTo("http://example.com/a.png");
        assertThat(MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null, null, null,
                null, "https://sub.example.com:8443/a.png?x=1#f", "ID3").artworkUrl())
                .isEqualTo("https://sub.example.com:8443/a.png?x=1#f");

        for (String unsafe : List.of(
                "javascript:alert(1)",
                "data:image/png;base64,AAAA",
                "file:///etc/passwd",
                "ftp://example.com/a.png",
                "https://user:pass@example.com/a.png",
                "https://localhost/a.png",
                "https://127.0.0.1/a.png",
                "https://[::1]/a.png",
                "https://169.254.169.254/latest/meta-data/",
                "https://minio.local/a.png",
                "https://service.internal/a.png",
                "/relative/a.png",
                "https:///nohost.png",
                "https://example.com/" + "a".repeat(2048))) {
            assertInvalid(() -> MediaMetadata.sanitize("IMAGE", null, 10, 10, null, null, null,
                    null, null, unsafe, "CLIENT"), "media.artwork_url");
        }
    }

    @Test
    void voiceMimeRequiresAudioKindAndBoundedDuration() {
        MediaMetadata voice = MediaMetadata.sanitize("AUDIO", 12_000L, null, null, null, null,
                null, null, null, null, "CLIENT");
        voice.assertCompatibleWith("audio/webm; codecs=opus");
        voice.assertCompatibleWith("AUDIO/OGG");

        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", null, null, null, null, null, null,
                null, null, null, "CLIENT").assertCompatibleWith("audio/webm"),
                "media.duration_ms");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 0L, null, null, null, null, null,
                null, null, null, "CLIENT").assertCompatibleWith("audio/ogg"),
                "media.duration_ms");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO",
                MediaMetadata.MAX_VOICE_DURATION_MS + 1, null, null, null, null, null, null,
                null, null, "CLIENT").assertCompatibleWith("audio/webm"), "media.duration_ms");
        assertInvalid(() -> MediaMetadata.sanitize("FILE", 12_000L, null, null, null, null,
                null, null, null, null, "CLIENT").assertCompatibleWith("audio/webm"),
                "media.kind");
    }

    @Test
    void kindMustMatchTheMimeFamily() {
        assertThatThrownBy(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null,
                null, null, null, null, "ID3").assertCompatibleWith("audio/x-ms-wma"))
                .isInstanceOf(UnsupportedFileTypeException.class)
                .extracting(error -> ((DomainException) error).code())
                .isEqualTo("UNSUPPORTED_TYPE");
        assertInvalid(() -> MediaMetadata.sanitize("AUDIO", 1L, null, null, null, null, null,
                null, null, null, "ID3").assertCompatibleWith("application/pdf"), "media.kind");
        assertInvalid(() -> MediaMetadata.sanitize("VIDEO", 1L, null, null, null, null, null,
                null, null, null, "ID3").assertCompatibleWith("audio/mpeg"), "media.kind");
        assertInvalid(() -> MediaMetadata.sanitize("IMAGE", null, 10, 10, null, null, null,
                null, null, null, "ID3").assertCompatibleWith("application/pdf"), "media.kind");
        // FILE has no MIME family restriction.
        MediaMetadata.sanitize("FILE", null, null, null, null, null, null, null, null, null,
                "NONE").assertCompatibleWith("application/pdf");
    }

    @Test
    void recognizesVoiceMimeWithParametersAndCase() {
        assertThat(MediaMetadata.isVoiceMime("audio/webm;codecs=opus")).isTrue();
        assertThat(MediaMetadata.isVoiceMime("AUDIO/OGG")).isTrue();
        assertThat(MediaMetadata.isVoiceMime("audio/mpeg")).isFalse();
        assertThat(MediaMetadata.isVoiceMime(null)).isFalse();
    }

    @Test
    void malformedPersistedMediaIsOmittedInsteadOfFailingTheMessage() {
        Map<String, Object> broken = new LinkedHashMap<>();
        broken.put("kind", "AUDIO");
        broken.put("metadata_source", "ID3");
        broken.put("title", "<img src=x onerror=alert(1)>");
        assertThat(MediaMetadata.fromMap(broken)).isNull();
        assertThat(MediaMetadata.fromMap(Map.of())).isNull();
        assertThat(MediaMetadata.fromMap(null)).isNull();
        assertThat(MediaMetadata.fromMap(Map.of("kind", 42))).isNull();
    }

    private static void assertInvalid(Runnable action, String field) {
        assertThatThrownBy(action::run)
                .isInstanceOf(MediaMetadataInvalidException.class)
                .extracting(error -> ((DomainException) error).details().get("field"))
                .isEqualTo(field);
    }
}
