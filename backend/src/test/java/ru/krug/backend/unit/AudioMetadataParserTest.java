package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.util.Arrays;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.model.AudioMetadata;
import ru.krug.backend.file.domain.service.AudioMetadataParser;
import ru.krug.backend.support.AudioTestData;

/**
 * #97: bounded ID3v2.2/2.3/2.4 and M4A parser coverage. Every malformed/oversized case must
 * fall back to an empty result instead of throwing; no fixture is ever fetched from a URL.
 */
class AudioMetadataParserTest {

    private static AudioMetadata parse(byte[] data) {
        return AudioMetadataParser.parse(new ByteArrayInputStream(data), data.length);
    }

    @Test
    void readsId3v23TextFramesAndApicArtwork() {
        byte[] artwork = AudioTestData.jpegArtwork();
        AudioMetadata parsed = parse(AudioTestData.mp3Id3v23("Song title", "Artist", "Album",
                "2024", "Rock", artwork));

        assertThat(parsed.title()).isEqualTo("Song title");
        assertThat(parsed.artist()).isEqualTo("Artist");
        assertThat(parsed.album()).isEqualTo("Album");
        assertThat(parsed.year()).isEqualTo("2024");
        assertThat(parsed.genre()).isEqualTo("Rock");
        assertThat(parsed.durationMs()).isNotNull().isPositive();
        assertThat(parsed.artwork()).isNotNull();
        assertThat(parsed.artwork().mimeType()).isEqualTo("image/jpeg");
        assertThat(parsed.artwork().bytes()).isEqualTo(artwork);
    }

    @Test
    void readsId3v24SyncsafeFramesAndTdrcYear() {
        byte[] parsed = AudioTestData.mp3Id3v24("New title", "New artist", "New album",
                "2021-09-30", "Jazz", AudioTestData.pngArtwork());

        AudioMetadata metadata = parse(parsed);
        assertThat(metadata.title()).isEqualTo("New title");
        assertThat(metadata.artist()).isEqualTo("New artist");
        assertThat(metadata.album()).isEqualTo("New album");
        assertThat(metadata.year()).isEqualTo("2021");
        assertThat(metadata.genre()).isEqualTo("Jazz");
        assertThat(metadata.artwork()).isNotNull();
        assertThat(metadata.artwork().mimeType()).isEqualTo("image/png");
    }

    @Test
    void readsId3v22ThreeCharFramesAndPic() {
        AudioMetadata metadata = parse(AudioTestData.mp3Id3v22("Old title", "Old artist",
                "Old album", "1999", "Pop", AudioTestData.jpegArtwork()));

        assertThat(metadata.title()).isEqualTo("Old title");
        assertThat(metadata.artist()).isEqualTo("Old artist");
        assertThat(metadata.album()).isEqualTo("Old album");
        assertThat(metadata.year()).isEqualTo("1999");
        assertThat(metadata.genre()).isEqualTo("Pop");
        assertThat(metadata.artwork()).isNotNull();
        assertThat(metadata.artwork().mimeType()).isEqualTo("image/jpeg");
    }

    @Test
    void declaredApicMimeIsIgnoredAndMagicBytesDecideTheType() {
        // The builder always declares image/jpeg in APIC while the payload is a PNG.
        AudioMetadata metadata = parse(AudioTestData.mp3Id3v23("X", null, null, null, null,
                AudioTestData.pngArtwork()));

        assertThat(metadata.artwork()).isNotNull();
        assertThat(metadata.artwork().mimeType()).isEqualTo("image/png");
    }

    @Test
    void readsM4aIlstAtomsCovrAndMvhdDuration() {
        byte[] artwork = AudioTestData.pngArtwork();
        AudioMetadata metadata = parse(AudioTestData.m4a("M4A title", "M4A artist",
                "M4A album", "2020", "Electronic", artwork, 65_000));

        assertThat(metadata.title()).isEqualTo("M4A title");
        assertThat(metadata.artist()).isEqualTo("M4A artist");
        assertThat(metadata.album()).isEqualTo("M4A album");
        assertThat(metadata.year()).isEqualTo("2020");
        assertThat(metadata.genre()).isEqualTo("Electronic");
        assertThat(metadata.durationMs()).isEqualTo(65_000);
        assertThat(metadata.artwork()).isNotNull();
        assertThat(metadata.artwork().mimeType()).isEqualTo("image/png");
        assertThat(metadata.artwork().bytes()).isEqualTo(artwork);
    }

    @Test
    void readsM4aNumericGnreGenre() {
        // ID3 genre index 18 = Rock (1-based in the atom).
        AudioMetadata metadata = parse(AudioTestData.m4aWithNumericGenre(18));
        assertThat(metadata.genre()).isEqualTo("Rock");
    }

    @Test
    void malformedM4aIsIgnoredInsteadOfThrowing() {
        byte[] valid = AudioTestData.m4a("T", "A", "L", "2020", "Rock", null, 10_000);
        byte[] truncated = Arrays.copyOf(valid, 24);

        AudioMetadata metadata = parse(truncated);

        assertThat(metadata.isEmpty()).isTrue();
    }

    @Test
    void estimatesMp3DurationWithoutAnyTag() {
        AudioMetadata metadata = parse(AudioTestData.mp3WithoutTags(120));

        assertThat(metadata.title()).isNull();
        assertThat(metadata.durationMs()).isNotNull();
        // 120 frames * 417 bytes at 128 kbps = ~3128 ms.
        assertThat(metadata.durationMs()).isBetween(2_900L, 3_400L);
    }

    @Test
    void emptyId3TagStillYieldsTheFrameEstimate() {
        AudioMetadata metadata = parse(AudioTestData.mp3EmptyTag());

        assertThat(metadata.title()).isNull();
        assertThat(metadata.artist()).isNull();
        assertThat(metadata.artwork()).isNull();
        assertThat(metadata.durationMs()).isNotNull().isPositive();
    }

    @Test
    void unknownBytesProduceEmptyMetadata() {
        byte[] random = new byte[512];
        new java.util.Random(7).nextBytes(random);
        random[0] = 0;

        assertThat(parse(random).isEmpty()).isTrue();
    }

    @Test
    void oversizedTagIsRejectedBeforeAllocation() {
        assertThat(parse(AudioTestData.mp3OversizedTag()).isEmpty()).isTrue();
    }

    @Test
    void oversizedArtworkIsIgnoredWhileTextSurvives() {
        byte[] huge = new byte[AudioMetadataParser.MAX_ARTWORK_BYTES + 1024];
        huge[0] = (byte) 0xff;
        huge[1] = (byte) 0xd8;
        huge[2] = (byte) 0xff;

        AudioMetadata metadata = parse(AudioTestData.mp3Id3v23("Still here", null, null, null,
                null, huge));

        assertThat(metadata.title()).isEqualTo("Still here");
        assertThat(metadata.artwork()).isNull();
    }

    @Test
    void malformedFrameSizeDoesNotThrow() {
        byte[] header = new byte[] {'I', 'D', '3', 3, 0, 0, 0, 0, 0, 12};
        byte[] brokenFrame = new byte[12];
        brokenFrame[0] = 'T';
        brokenFrame[1] = 'I';
        brokenFrame[2] = 'T';
        brokenFrame[3] = '2';
        // Declared size 0x7fffffff, far larger than the remaining body.
        brokenFrame[4] = 0x7f;
        brokenFrame[5] = (byte) 0xff;
        brokenFrame[6] = (byte) 0xff;
        brokenFrame[7] = (byte) 0xff;

        AudioMetadata metadata = parse(AudioTestData.concatBytes(header, brokenFrame,
                AudioTestData.mp3WithoutTags(10)));

        assertThat(metadata.title()).isNull();
    }

    @Test
    void hostileTagTextIsSanitizedToDisplayText() {
        AudioMetadata metadata = parse(AudioTestData.mp3Id3v23(
                "<script>alert(1)</script>", "Artist\u0000Name", null, "2024", "(17)Rock",
                null));

        assertThat(metadata.title()).doesNotContain("<", ">").contains("script");
        assertThat(metadata.artist()).isEqualTo("Artist, Name");
        assertThat(metadata.genre()).isEqualTo("Rock");
        assertThat(metadata.year()).isEqualTo("2024");
    }

    @Test
    void rejectsCompressedAndEncryptedApicFramesWithoutDecompressing() {
        // A v2.3 APIC frame with the compression flag set must be skipped, not inflated.
        byte[] image = AudioTestData.jpegArtwork();
        byte[] payload = AudioTestData.concatBytes(new byte[] {0},
                "image/jpeg".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1),
                new byte[] {0, 0x03, 0}, image);
        byte[] frame = new byte[10 + payload.length];
        byte[] id = "APIC".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        System.arraycopy(id, 0, frame, 0, 4);
        int size = payload.length;
        frame[4] = (byte) ((size >> 24) & 0xff);
        frame[5] = (byte) ((size >> 16) & 0xff);
        frame[6] = (byte) ((size >> 8) & 0xff);
        frame[7] = (byte) (size & 0xff);
        frame[8] = (byte) 0x80; // compression
        System.arraycopy(payload, 0, frame, 10, payload.length);
        byte[] body = frame;
        byte[] header = new byte[] {'I', 'D', '3', 3, 0, 0,
                (byte) ((body.length >> 21) & 0x7f), (byte) ((body.length >> 14) & 0x7f),
                (byte) ((body.length >> 7) & 0x7f), (byte) (body.length & 0x7f)};

        AudioMetadata metadata = parse(AudioTestData.concatBytes(header, body));

        assertThat(metadata.artwork()).isNull();
    }
}
