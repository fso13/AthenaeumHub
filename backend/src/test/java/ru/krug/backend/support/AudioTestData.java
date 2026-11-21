package ru.krug.backend.support;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * byte-level MP3/M4A fixtures for #97. Builds real ID3v2.2/2.3/2.4 tags and MP4 atoms so the
 * server parser is exercised on the same shapes iTunes/ffmpeg write, without binary fixtures
 * in the repository.
 */
public final class AudioTestData {

    /** A 128 kbps / 44.1 kHz MPEG-1 Layer III frame (417 bytes). */
    public static final int MP3_FRAME_BYTES = 417;

    private AudioTestData() {
    }

    public static byte[] jpegArtwork() {
        return new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0x00, 0x10,
                'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
                0x00, (byte) 0xff, (byte) 0xd9};
    }

    public static byte[] pngArtwork() {
        return new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
                0x00, 0x0d, 'I', 'H', 'D', 'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
                0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x49, 0x45, 0x4e, 0x44, (byte) 0xae, 0x42, 0x60, (byte) 0x82};
    }

    /** ID3v2.3 tag with the classic text frames and an APIC cover. */
    public static byte[] mp3Id3v23(String title, String artist, String album, String year,
                                   String genre, byte[] artwork) {
        List<Frame> frames = textFrames(3, title, artist, album, year, genre);
        if (artwork != null) {
            frames.add(new Frame("APIC", apic(artwork)));
        }
        return concat(id3Tag(3, frames), mp3Audio(120));
    }

    /** ID3v2.4 tag: TDRC instead of TYER and syncsafe frame sizes. */
    public static byte[] mp3Id3v24(String title, String artist, String album, String year,
                                   String genre, byte[] artwork) {
        List<Frame> frames = Id3Frames.v24(title, artist, album, year, genre);
        if (artwork != null) {
            frames.add(new Frame("APIC", apic(artwork)));
        }
        return concat(id3Tag(4, frames), mp3Audio(120));
    }

    /** ID3v2.2 tag: 3-char frame ids and PIC. */
    public static byte[] mp3Id3v22(String title, String artist, String album, String year,
                                   String genre, byte[] artwork) {
        List<Frame> frames = new ArrayList<>();
        if (title != null) {
            frames.add(new Frame("TT2", textPayload(0, title)));
        }
        if (artist != null) {
            frames.add(new Frame("TP1", textPayload(0, artist)));
        }
        if (album != null) {
            frames.add(new Frame("TAL", textPayload(0, album)));
        }
        if (year != null) {
            frames.add(new Frame("TYE", textPayload(0, year)));
        }
        if (genre != null) {
            frames.add(new Frame("TCO", textPayload(0, genre)));
        }
        if (artwork != null) {
            frames.add(new Frame("PIC", pic("JPG", artwork)));
        }
        return concat(id3Tag(2, frames), mp3Audio(120));
    }

    /** An MP3 with no ID3 tag at all (plain CBR frames). */
    public static byte[] mp3WithoutTags(int frames) {
        return mp3Audio(frames);
    }

    /** ID3 header only, no frames: a valid but empty tag. */
    public static byte[] mp3EmptyTag() {
        return concat(id3Tag(3, List.of()), mp3Audio(60));
    }

    /** A tag whose declared size exceeds the server cap. */
    public static byte[] mp3OversizedTag() {
        byte[] header = id3Header(3, 9 * 1024 * 1024);
        return concat(header, new byte[32]);
    }

    public static byte[] m4a(String title, String artist, String album, String year,
                             String genre, byte[] artwork, int durationMs) {
        List<byte[]> items = new ArrayList<>();
        if (title != null) {
            items.add(ilstItem("\u00a9nam", 1, title.getBytes(StandardCharsets.UTF_8)));
        }
        if (artist != null) {
            items.add(ilstItem("\u00a9ART", 1, artist.getBytes(StandardCharsets.UTF_8)));
        }
        if (album != null) {
            items.add(ilstItem("\u00a9alb", 1, album.getBytes(StandardCharsets.UTF_8)));
        }
        if (year != null) {
            items.add(ilstItem("\u00a9day", 1, year.getBytes(StandardCharsets.UTF_8)));
        }
        if (genre != null) {
            items.add(ilstItem("\u00a9gen", 1, genre.getBytes(StandardCharsets.UTF_8)));
        }
        if (artwork != null) {
            items.add(ilstItem("covr", 14, artwork));
        }
        byte[] ilst = box("ilst", concat(items.toArray(new byte[0][])));
        byte[] meta = fullBox("meta", concat(box("hdlr", new byte[24]), ilst));
        byte[] moov = box("moov", concat(
                box("mvhd", mvhd(durationMs)), box("udta", meta)));
        byte[] ftyp = box("ftyp", concat("M4A ".getBytes(StandardCharsets.ISO_8859_1),
                new byte[] {0, 0, 0, 0}, "M4A mp42isom".getBytes(StandardCharsets.ISO_8859_1)));
        byte[] mdat = box("mdat", new byte[256]);
        // moov after mdat: the parser must walk past mdat rather than trusting a prefix.
        return concat(ftyp, mdat, moov);
    }

    public static byte[] m4aWithoutTags(int durationMs) {
        return m4a(null, null, null, null, null, null, durationMs);
    }

    /** M4A with gnre (numeric ID3 genre) instead of ©gen. */
    public static byte[] m4aWithNumericGenre(int genreIndex) {
        byte[] gnre = ilstItem("gnre", 0, new byte[] {0, (byte) genreIndex});
        byte[] ilst = box("ilst", gnre);
        byte[] meta = fullBox("meta", concat(box("hdlr", new byte[24]), ilst));
        byte[] moov = box("moov", concat(box("mvhd", mvhd(30_000)), box("udta", meta)));
        return concat(box("ftyp", concat("M4A ".getBytes(StandardCharsets.ISO_8859_1),
                new byte[] {0, 0, 0, 0}, "M4A ".getBytes(StandardCharsets.ISO_8859_1))),
                moov, box("mdat", new byte[64]));
    }

    private static List<Frame> textFrames(int major, String title, String artist, String album,
                                          String year, String genre) {
        List<Frame> frames = new ArrayList<>();
        if (major >= 3) {
            if (title != null) {
                frames.add(new Frame("TIT2", textPayload(0, title)));
            }
            if (artist != null) {
                frames.add(new Frame("TPE1", textPayload(0, artist)));
            }
            if (album != null) {
                frames.add(new Frame("TALB", textPayload(0, album)));
            }
            if (year != null) {
                frames.add(new Frame("TYER", textPayload(0, year)));
            }
            if (genre != null) {
                frames.add(new Frame("TCON", textPayload(0, genre)));
            }
        }
        return frames;
    }

    // ------------------------------------------------------------------

    private record Frame(String id, byte[] payload) {
    }

    private static final class Id3Frames {
        private static List<Frame> v24(String title, String artist, String album, String year,
                                       String genre) {
            List<Frame> frames = new ArrayList<>();
            if (title != null) {
                frames.add(new Frame("TIT2", textPayload(3, title)));
            }
            if (artist != null) {
                frames.add(new Frame("TPE1", textPayload(3, artist)));
            }
            if (album != null) {
                frames.add(new Frame("TALB", textPayload(3, album)));
            }
            if (year != null) {
                frames.add(new Frame("TDRC", textPayload(3, year)));
            }
            if (genre != null) {
                frames.add(new Frame("TCON", textPayload(3, genre)));
            }
            return frames;
        }
    }

    private static byte[] textPayload(int encoding, String value) {
        byte[] text = switch (encoding) {
            case 1 -> concat(new byte[] {(byte) 0xff, (byte) 0xfe},
                    value.getBytes(StandardCharsets.UTF_16LE));
            case 3 -> value.getBytes(StandardCharsets.UTF_8);
            default -> value.getBytes(StandardCharsets.ISO_8859_1);
        };
        return concat(new byte[] {(byte) encoding}, text);
    }

    private static byte[] apic(byte[] image) {
        byte[] mime = "image/jpeg".getBytes(StandardCharsets.ISO_8859_1);
        return concat(new byte[] {0}, mime, new byte[] {0, 0x03, 0}, image);
    }

    private static byte[] pic(String format, byte[] image) {
        return concat(new byte[] {0}, format.getBytes(StandardCharsets.ISO_8859_1),
                new byte[] {0x03, 0}, image);
    }

    private static byte[] id3Tag(int major, List<Frame> frames) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (Frame frame : frames) {
            body.writeBytes(id3Frame(major, frame.id(), frame.payload()));
        }
        return concat(id3Header(major, body.size()), body.toByteArray());
    }

    private static byte[] id3Header(int major, int size) {
        return new byte[] {'I', 'D', '3', (byte) major, 0, 0,
                (byte) ((size >> 21) & 0x7f), (byte) ((size >> 14) & 0x7f),
                (byte) ((size >> 7) & 0x7f), (byte) (size & 0x7f)};
    }

    private static byte[] id3Frame(int major, String id, byte[] payload) {
        if (major == 2) {
            byte[] header = new byte[6];
            byte[] idBytes = id.getBytes(StandardCharsets.ISO_8859_1);
            header[0] = idBytes[0];
            header[1] = idBytes[1];
            header[2] = idBytes[2];
            header[3] = (byte) ((payload.length >> 16) & 0xff);
            header[4] = (byte) ((payload.length >> 8) & 0xff);
            header[5] = (byte) (payload.length & 0xff);
            return concat(header, payload);
        }
        byte[] header = new byte[10];
        byte[] idBytes = id.getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(idBytes, 0, header, 0, 4);
        int size = payload.length;
        if (major == 4) {
            header[4] = (byte) ((size >> 21) & 0x7f);
            header[5] = (byte) ((size >> 14) & 0x7f);
            header[6] = (byte) ((size >> 7) & 0x7f);
            header[7] = (byte) (size & 0x7f);
        } else {
            header[4] = (byte) ((size >> 24) & 0xff);
            header[5] = (byte) ((size >> 16) & 0xff);
            header[6] = (byte) ((size >> 8) & 0xff);
            header[7] = (byte) (size & 0xff);
        }
        return concat(header, payload);
    }

    private static byte[] mp3Audio(int frames) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(frames * MP3_FRAME_BYTES);
        for (int i = 0; i < frames; i++) {
            out.writeBytes(mp3Frame());
        }
        return out.toByteArray();
    }

    private static byte[] mp3Frame() {
        byte[] frame = new byte[MP3_FRAME_BYTES];
        frame[0] = (byte) 0xff;
        frame[1] = (byte) 0xfb;
        frame[2] = (byte) 0x90;
        frame[3] = 0;
        return frame;
    }

    private static byte[] mvhd(int durationMs) {
        ByteBuffer body = ByteBuffer.allocate(24);
        body.putInt(0); // version + flags
        body.putInt(0); // creation time
        body.putInt(0); // modification time
        body.putInt(1000); // timescale
        body.putInt(durationMs); // duration in timescale units
        body.putInt(0); // rate placeholder
        return body.array();
    }

    private static byte[] ilstItem(String key, int dataType, byte[] payload) {
        byte[] data = box("data", concat(uint32(dataType), uint32(0), payload));
        return box(key, data);
    }

    private static byte[] fullBox(String type, byte[] payload) {
        return box(type, concat(new byte[4], payload));
    }

    private static byte[] box(String type, byte[] payload) {
        byte[] typeBytes = type.getBytes(StandardCharsets.ISO_8859_1);
        ByteBuffer buffer = ByteBuffer.allocate(8 + payload.length);
        buffer.putInt(8 + payload.length);
        buffer.put(typeBytes, 0, 4);
        buffer.put(payload);
        return buffer.array();
    }

    private static byte[] uint32(long value) {
        return ByteBuffer.allocate(4).putInt((int) value).array();
    }

    private static byte[] concat(byte[]... values) {
        int length = 0;
        for (byte[] value : values) {
            length += value.length;
        }
        byte[] result = new byte[length];
        int offset = 0;
        for (byte[] value : values) {
            System.arraycopy(value, 0, result, offset, value.length);
            offset += value.length;
        }
        return result;
    }

    public static byte[] concatBytes(byte[]... values) {
        return concat(values);
    }

    /** Convenience for tests that only need a tag map. */
    public static Map<String, String> songTags() {
        return Map.of("title", "Song title", "artist", "Artist", "album", "Album",
                "year", "2024", "genre", "Rock");
    }
}
