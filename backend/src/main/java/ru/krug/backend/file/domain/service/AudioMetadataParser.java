package ru.krug.backend.file.domain.service;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import ru.krug.backend.file.domain.model.AudioMetadata;
import ru.krug.backend.file.domain.model.MediaMetadata;

/**
 * Defensive, dependency-free server-side audio tag reader (#97).
 *
 * <p>Scope:
 * <ul>
 *   <li>MP3 ID3v2.2 ({@code TT2}/{@code TP1}/{@code TAL}/{@code TYE}/{@code TCO}/{@code PIC}),
 *       ID3v2.3 ({@code TIT2}/{@code TPE1}/{@code TALB}/{@code TYER}/{@code TCON}/{@code APIC})
 *       and ID3v2.4 ({@code TDRC}, syncsafe frame sizes);</li>
 *   <li>M4A/MP4 {@code moov/udta/meta/ilst} atoms: {@code ©nam}, {@code ©ART}, {@code ©alb},
 *       {@code ©day}, {@code ©gen}/{@code gnre} and {@code covr}; duration from {@code mvhd};</li>
 *   <li>MP3 duration from the {@code TLEN} frame, a Xing/Info frame count or a bounded CBR
 *       frame estimate.</li>
 * </ul>
 *
 * <p>Safety properties:
 * <ul>
 *   <li>no network access, no URL is ever fetched or resolved;</li>
 *   <li>every read is bounded: tag ≤ {@value #MAX_TAG_BYTES}, cover ≤
 *       {@value #MAX_ARTWORK_BYTES}, text frame ≤ {@value #MAX_TEXT_FRAME_BYTES};</li>
 *   <li>frame/atom sizes are validated against the already-read buffer before any slicing,
 *       integer overflow is avoided by using {@code long} for box lengths;</li>
 *   <li>compressed/encrypted ID3 frames are skipped, never decompressed (no ZIP/compression
 *       bomb surface); MP4 is parsed structurally and never inflated;</li>
 *   <li>malformed input returns an empty {@link AudioMetadata} instead of throwing, so an
 *       upload is never rejected because of broken tags.</li>
 * </ul>
 */
public final class AudioMetadataParser {

    /** Whole tag, header included. Larger tags are ignored, like the client parser. */
    public static final int MAX_TAG_BYTES = 8 * 1024 * 1024;
    /** Embedded cover cap; larger APIC/PIC/covr payloads are ignored. */
    public static final int MAX_ARTWORK_BYTES = 2 * 1024 * 1024;
    /** A text frame larger than this is not user metadata. */
    public static final int MAX_TEXT_FRAME_BYTES = 64 * 1024;
    /** Upper bound on frames/atoms walked in one file. */
    public static final int MAX_FRAMES = 4096;
    public static final int MAX_BOXES = 4096;
    /** A moov atom larger than this is not read into memory. */
    public static final int MAX_MOOV_BYTES = 8 * 1024 * 1024;
    /** Recursion cap for malformed/self-nesting atom trees. */
    public static final int MAX_DEPTH = 8;
    /** Bytes scanned for the first MPEG audio frame after the ID3 tag. */
    private static final int MAX_MP3_FRAME_SCAN = 128 * 1024;
    private static final int MAX_ARTWORK_DESCRIPTION_BYTES = 4096;

    private static final Pattern YEAR_PATTERN = Pattern.compile("(?:^|\\D)(\\d{4})(?:\\D|$)");

    private static final String[] GENRES = {
        "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
        "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock",
        "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack",
        "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
        "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
        "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
        "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
        "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
        "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret",
        "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal",
        "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock"
    };

    private AudioMetadataParser() {
    }

    /**
     * Parses a bounded prefix/stream. {@code totalSize} is the declared file size (needed for
     * the CBR duration estimate and for validating MP4 box lengths); it is never trusted for
     * allocation because every buffer is capped.
     */
    public static AudioMetadata parse(InputStream input, long totalSize) {
        if (input == null || totalSize <= 0) {
            return AudioMetadata.empty();
        }
        try {
            BufferedInputStream in = input instanceof BufferedInputStream buffered
                    ? buffered : new BufferedInputStream(input, 16 * 1024);
            in.mark(16);
            byte[] head = in.readNBytes(12);
            in.reset();
            if (isId3(head)) {
                return parseMp3(in, totalSize);
            }
            if (isMp4(head)) {
                return parseMp4(in, totalSize);
            }
            if (isMpegSync(head)) {
                return build(estimateMp3Duration(in, totalSize, 0), null, null, null, null,
                        null, null);
            }
            return AudioMetadata.empty();
        } catch (IOException | RuntimeException ex) {
            // Broken tags are a fallback card, never a failed upload.
            return AudioMetadata.empty();
        }
    }

    // ------------------------------------------------------------------
    // MP3 / ID3v2
    // ------------------------------------------------------------------

    private static AudioMetadata parseMp3(InputStream in, long totalSize) throws IOException {
        byte[] header = new byte[10];
        if (readAtMost(in, header, 10) < 10 || !isId3(header)) {
            return AudioMetadata.empty();
        }
        int major = header[3] & 0xff;
        int flags = header[5] & 0xff;
        if (major < 2 || major > 4 || (header[4] & 0xff) == 0xff) {
            return AudioMetadata.empty();
        }
        long declaredTagSize = syncsafe(header, 6);
        long tagTotal = 10 + declaredTagSize;
        // The whole tag must stay inside the hard cap before any allocation.
        if (declaredTagSize < 0 || tagTotal > MAX_TAG_BYTES) {
            return AudioMetadata.empty();
        }
        if (tagTotal > totalSize) {
            return AudioMetadata.empty();
        }
        byte[] body = in.readNBytes((int) declaredTagSize);
        if (body.length != declaredTagSize) {
            return AudioMetadata.empty();
        }
        if ((flags & 0x80) != 0) {
            body = deunsynchronize(body);
        }
        MutableTags tags = new MutableTags();
        ArtworkHolder artwork = new ArtworkHolder();
        parseId3Frames(major, flags, body, tags, artwork);
        Long duration = tags.durationMs != null
                ? clampDuration(tags.durationMs)
                : estimateMp3Duration(in, totalSize, tagTotal);
        return build(duration, tags.title, tags.artist, tags.album, tags.year, tags.genre,
                artwork.value);
    }

    private static void parseId3Frames(int major, int flags, byte[] body, MutableTags tags,
                                       ArtworkHolder artwork) {
        int offset = 0;
        // v2.3: size excludes the 4-byte size field; v2.4: size includes it.
        if (major >= 3 && (flags & 0x40) != 0) {
            if (body.length < 4) {
                return;
            }
            long extended = major == 4 ? syncsafe(body, 0) : u32(body, 0);
            if (extended < 4) {
                return;
            }
            long next = major == 4 ? extended : extended + 4;
            if (next > body.length) {
                return;
            }
            offset = (int) next;
        }

        int headerSize = major == 2 ? 6 : 10;
        int idLength = major == 2 ? 3 : 4;
        int frames = 0;
        while (offset + headerSize <= body.length && frames++ < MAX_FRAMES) {
            if (isPadding(body, offset)) {
                break;
            }
            String frameId = ArtworkImages.ascii(body, offset, idLength);
            if (!frameId.matches("[A-Z0-9]+")) {
                break;
            }
            long rawSize;
            long frameSize;
            if (major == 2) {
                rawSize = u24(body, offset + 3);
                frameSize = rawSize;
            } else if (major == 4) {
                rawSize = u32(body, offset + 4);
                frameSize = syncsafe(body, offset + 4);
                if (frameSize < 0 || frameSize > body.length - offset - headerSize) {
                    // Some writers emit a plain big-endian v2.4 size; accept it only if it
                    // actually fits, otherwise the frame (and the rest of the tag) is broken.
                    frameSize = rawSize;
                }
            } else {
                rawSize = u32(body, offset + 4);
                frameSize = rawSize;
            }
            if (frameSize < 0 || frameSize > body.length - offset - headerSize) {
                break;
            }
            int payloadStart = offset + headerSize;
            int payloadLength = (int) frameSize;
            int frameEnd = payloadStart + payloadLength;
            offset = frameEnd;

            byte[] payload = Arrays.copyOfRange(body, payloadStart, frameEnd);
            if (major == 3) {
                int frameFlags = body[payloadStart - 2] & 0xff;
                // Compression/encryption are never supported and never decompressed.
                if ((frameFlags & 0xc0) != 0) {
                    continue;
                }
                if ((frameFlags & 0x20) != 0 && payload.length > 0) {
                    payload = Arrays.copyOfRange(payload, 1, payload.length);
                }
            } else if (major == 4) {
                int frameFlags = body[payloadStart - 2] & 0xff;
                if ((frameFlags & 0x0c) != 0) {
                    continue;
                }
                int skip = 0;
                if ((frameFlags & 0x40) != 0) {
                    skip += 1;
                }
                if ((frameFlags & 0x01) != 0) {
                    skip += 4;
                }
                if (skip > 0) {
                    if (skip >= payload.length) {
                        continue;
                    }
                    payload = Arrays.copyOfRange(payload, skip, payload.length);
                }
                if ((frameFlags & 0x02) != 0) {
                    payload = deunsynchronize(payload);
                }
            }
            if (major == 2 && ("PIC".equals(frameId))) {
                if (artwork.value == null) {
                    artwork.value = parsePic(payload);
                }
                continue;
            }
            if ("APIC".equals(frameId)) {
                if (artwork.value == null) {
                    artwork.value = parseApic(payload);
                }
                continue;
            }
            if (payload.length > MAX_TEXT_FRAME_BYTES) {
                continue;
            }
            switch (frameId) {
                case "TT2", "TIT2" -> tags.title = firstNonNull(tags.title,
                        parseTextFrame(payload, 255));
                case "TP1", "TPE1" -> tags.artist = firstNonNull(tags.artist,
                        parseTextFrame(payload, 255));
                case "TAL", "TALB" -> tags.album = firstNonNull(tags.album,
                        parseTextFrame(payload, 255));
                case "TYE", "TYER", "TDRC" -> tags.year = firstNonNull(tags.year,
                        cleanYear(parseTextFrame(payload, 64)));
                case "TCO", "TCON" -> tags.genre = firstNonNull(tags.genre,
                        cleanGenre(parseTextFrame(payload, 256)));
                case "TLE", "TLEN" -> tags.durationMs = tags.durationMs == null
                        ? cleanDuration(parseTextFrame(payload, 32)) : tags.durationMs;
                default -> {
                    // Not metadata we expose.
                }
            }
        }
    }

    private static AudioMetadata.Artwork parseApic(byte[] payload) {
        if (payload == null || payload.length < 5) {
            return null;
        }
        int encoding = payload[0] & 0xff;
        int mimeEnd = findTerminator(payload, 1, 1, 256);
        if (mimeEnd < 0) {
            return null;
        }
        int afterMime = mimeEnd + 1;
        if (afterMime >= payload.length) {
            return null;
        }
        int descriptionStart = afterMime + 1;
        int step = encoding == 1 || encoding == 2 ? 2 : 1;
        int descriptionEnd = findTerminator(payload, descriptionStart, step,
                descriptionStart + MAX_ARTWORK_DESCRIPTION_BYTES);
        if (descriptionEnd < 0) {
            return null;
        }
        int imageStart = descriptionEnd + step;
        return artworkFrom(payload, imageStart);
    }

    private static AudioMetadata.Artwork parsePic(byte[] payload) {
        if (payload == null || payload.length < 5) {
            return null;
        }
        int encoding = payload[0] & 0xff;
        // 3-byte image format ("JPG"/"PNG"/...) is informational; magic bytes decide MIME.
        int afterFormat = 1 + 3;
        if (afterFormat >= payload.length) {
            return null;
        }
        int descriptionStart = afterFormat + 1;
        int step = encoding == 1 || encoding == 2 ? 2 : 1;
        int descriptionEnd = findTerminator(payload, descriptionStart, step,
                descriptionStart + MAX_ARTWORK_DESCRIPTION_BYTES);
        if (descriptionEnd < 0) {
            return null;
        }
        return artworkFrom(payload, descriptionEnd + step);
    }

    private static AudioMetadata.Artwork artworkFrom(byte[] payload, int start) {
        if (start < 0 || start >= payload.length) {
            return null;
        }
        int length = payload.length - start;
        if (length <= 0 || length > MAX_ARTWORK_BYTES) {
            return null;
        }
        byte[] image = Arrays.copyOfRange(payload, start, payload.length);
        String mime = ArtworkImages.sniffMimeType(image);
        return mime == null ? null : new AudioMetadata.Artwork(mime, image);
    }

    private static String parseTextFrame(byte[] payload, int maxLength) {
        if (payload.length < 1) {
            return null;
        }
        int encoding = payload[0] & 0xff;
        byte[] body = Arrays.copyOfRange(payload, 1, payload.length);
        String decoded = switch (encoding) {
            case 0 -> new String(body, StandardCharsets.ISO_8859_1);
            case 1 -> decodeUtf16(body);
            case 2 -> new String(body, StandardCharsets.UTF_16BE);
            case 3 -> new String(body, StandardCharsets.UTF_8);
            default -> null;
        };
        if (decoded == null) {
            return null;
        }
        String[] parts = decoded.split("\u0000");
        StringBuilder joined = new StringBuilder();
        for (String part : parts) {
            String value = sanitizeText(part, maxLength);
            if (value == null) {
                continue;
            }
            if (joined.length() > 0) {
                joined.append(", ");
            }
            joined.append(value);
        }
        return joined.isEmpty() ? null : sanitizeText(joined.toString(), maxLength);
    }

    private static String decodeUtf16(byte[] body) {
        if (body.length >= 2) {
            int first = body[0] & 0xff;
            int second = body[1] & 0xff;
            if (first == 0xfe && second == 0xff) {
                return new String(body, 2, body.length - 2, StandardCharsets.UTF_16BE);
            }
            if (first == 0xff && second == 0xfe) {
                return new String(body, 2, body.length - 2, StandardCharsets.UTF_16LE);
            }
        }
        // Most untagged UTF-16 frames in the wild are little-endian.
        return new String(body, StandardCharsets.UTF_16LE);
    }

    private static long syncsafe(byte[] bytes, int offset) {
        if (offset < 0 || offset + 4 > bytes.length) {
            return -1;
        }
        return ((long) (bytes[offset] & 0x7f) << 21)
                | ((long) (bytes[offset + 1] & 0x7f) << 14)
                | ((long) (bytes[offset + 2] & 0x7f) << 7)
                | (bytes[offset + 3] & 0x7f);
    }

    private static byte[] deunsynchronize(byte[] bytes) {
        byte[] output = new byte[bytes.length];
        int write = 0;
        for (int read = 0; read < bytes.length; read++) {
            byte value = bytes[read];
            output[write++] = value;
            if ((value & 0xff) == 0xff && read + 1 < bytes.length
                    && (bytes[read + 1] & 0xff) == 0x00) {
                read++;
            }
        }
        return Arrays.copyOf(output, write);
    }

    private static Long estimateMp3Duration(InputStream in, long totalSize, long audioStart) {
        if (totalSize <= audioStart + 4) {
            return null;
        }
        try {
            byte[] scan = in.readNBytes(MAX_MP3_FRAME_SCAN);
            for (int index = 0; index + 4 <= scan.length; index++) {
                FrameHeader header = frameHeader(scan, index);
                if (header == null) {
                    continue;
                }
                Long xing = xingDuration(scan, index, header);
                if (xing != null) {
                    return xing;
                }
                long audioBytes = totalSize - audioStart;
                if (audioBytes <= 0 || header.bitrateBps <= 0) {
                    return null;
                }
                long duration = Math.round(audioBytes * 8000.0 / header.bitrateBps);
                return clampDuration(duration);
            }
            return null;
        } catch (IOException | RuntimeException ex) {
            return null;
        }
    }

    private static FrameHeader frameHeader(byte[] bytes, int offset) {
        if (offset + 4 > bytes.length) {
            return null;
        }
        int b0 = bytes[offset] & 0xff;
        int b1 = bytes[offset + 1] & 0xff;
        int b2 = bytes[offset + 2] & 0xff;
        int b3 = bytes[offset + 3] & 0xff;
        if (b0 != 0xff || (b1 & 0xe0) != 0xe0) {
            return null;
        }
        int versionBits = (b1 >> 3) & 0x03;
        int layerBits = (b1 >> 1) & 0x03;
        int bitrateIndex = (b2 >> 4) & 0x0f;
        int sampleIndex = (b2 >> 2) & 0x03;
        if (versionBits == 1 || layerBits == 0 || bitrateIndex == 0 || bitrateIndex == 0x0f
                || sampleIndex == 3) {
            return null;
        }
        int version = switch (versionBits) {
            case 3 -> 1;
            case 2 -> 2;
            default -> 25;
        };
        int layer = 4 - layerBits; // 1..3
        int[] bitrates = bitrateTable(version, layer);
        int bitrate = bitrates[bitrateIndex] * 1000;
        int sampleRate = sampleRate(version, sampleIndex);
        if (bitrate <= 0 || sampleRate <= 0) {
            return null;
        }
        return new FrameHeader(version, layer, bitrate, sampleRate, (b3 >> 6) & 0x03,
                (b2 & 0x02) != 0);
    }

    private static Long xingDuration(byte[] bytes, int offset, FrameHeader header) {
        if (header.layer != 3) {
            return null;
        }
        int sideInfo = header.version == 1
                ? (header.channelMode == 3 ? 17 : 32)
                : (header.channelMode == 3 ? 9 : 17);
        int xingOffset = offset + 4 + sideInfo;
        if (xingOffset + 12 > bytes.length) {
            return null;
        }
        String marker = ArtworkImages.ascii(bytes, xingOffset, 4);
        if (!"Xing".equals(marker) && !"Info".equals(marker)) {
            return null;
        }
        long flags = u32(bytes, xingOffset + 4);
        if ((flags & 0x01) == 0) {
            return null;
        }
        long frames = u32(bytes, xingOffset + 8);
        if (frames <= 0) {
            return null;
        }
        int samplesPerFrame = header.version == 1 ? 1152 : 576;
        long duration = Math.round(frames * (double) samplesPerFrame * 1000.0
                / header.sampleRate);
        return clampDuration(duration);
    }

    private static int[] bitrateTable(int version, int layer) {
        if (version == 1 && layer == 1) {
            return new int[] {0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384,
                416, 448};
        }
        if (version == 1 && layer == 2) {
            return new int[] {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
                384};
        }
        if (version == 1) {
            return new int[] {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256,
                320};
        }
        if (layer == 1) {
            return new int[] {0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224,
                256};
        }
        if (layer == 2) {
            return new int[] {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160};
        }
        return new int[] {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160};
    }

    private static int sampleRate(int version, int index) {
        int[] rates = version == 1
                ? new int[] {44100, 48000, 32000}
                : version == 2 ? new int[] {22050, 24000, 16000}
                : new int[] {11025, 12000, 8000};
        return index < rates.length ? rates[index] : 0;
    }

    // ------------------------------------------------------------------
    // MP4 / M4A
    // ------------------------------------------------------------------

    private static AudioMetadata parseMp4(InputStream in, long totalSize) throws IOException {
        MutableTags tags = new MutableTags();
        ArtworkHolder artwork = new ArtworkHolder();
        LongHolder duration = new LongHolder();
        long position = 0;
        int boxes = 0;
        while (position + 8 <= totalSize && boxes++ < MAX_BOXES) {
            byte[] header = new byte[8];
            if (readAtMost(in, header, 8) < 8) {
                break;
            }
            long size = u32(header, 0);
            String type = ArtworkImages.ascii(header, 4, 4);
            int headerLength = 8;
            if (size == 1) {
                byte[] extended = new byte[8];
                if (readAtMost(in, extended, 8) < 8) {
                    break;
                }
                size = u64(extended, 0);
                headerLength = 16;
            } else if (size == 0) {
                size = totalSize - position;
            }
            if (size < headerLength || position + size > totalSize) {
                break;
            }
            long bodySize = size - headerLength;
            if ("moov".equals(type)) {
                int toRead = (int) Math.min(bodySize, MAX_MOOV_BYTES);
                byte[] moov = in.readNBytes(toRead);
                if (moov.length > 0) {
                    parseMoov(moov, tags, artwork, duration);
                }
                long skipped = skipFully(in, bodySize - moov.length);
                if (skipped < bodySize - moov.length) {
                    break;
                }
            } else if (skipFully(in, bodySize) < bodySize) {
                break;
            }
            position += size;
        }
        return build(clampDuration(duration.value), tags.title, tags.artist, tags.album,
                tags.year, tags.genre, artwork.value);
    }

    private static void parseMoov(byte[] data, MutableTags tags, ArtworkHolder artwork,
                                  LongHolder duration) {
        parseBoxes(data, 0, data.length, 0, tags, artwork, duration);
    }

    private static void parseBoxes(byte[] data, int start, int end, int depth, MutableTags tags,
                                   ArtworkHolder artwork, LongHolder duration) {
        if (depth > MAX_DEPTH || start < 0 || end > data.length || start > end) {
            return;
        }
        int offset = start;
        int count = 0;
        while (offset + 8 <= end && count++ < MAX_BOXES) {
            long size = u32(data, offset);
            String type = ArtworkImages.ascii(data, offset + 4, 4);
            int headerLength = 8;
            int body = offset + 8;
            if (size == 1) {
                if (offset + 16 > end) {
                    return;
                }
                size = u64(data, offset + 8);
                headerLength = 16;
                body = offset + 16;
            } else if (size == 0) {
                size = end - offset;
            }
            if (size < headerLength || size > end - offset) {
                return;
            }
            int bodyLength = (int) (size - headerLength);
            switch (type) {
                case "mvhd" -> parseMvhd(data, body, bodyLength, duration);
                case "udta" -> parseBoxes(data, body, body + bodyLength, depth + 1, tags,
                        artwork, duration);
                case "meta" -> {
                    if (bodyLength >= 4) {
                        parseBoxes(data, body + 4, body + bodyLength, depth + 1, tags,
                                artwork, duration);
                    }
                }
                case "ilst" -> parseIlst(data, body, body + bodyLength, depth + 1, tags,
                        artwork);
                default -> {
                    // Other atoms (trak/mdia/...) do not carry the display tags we expose.
                }
            }
            offset += (int) size;
        }
    }

    private static void parseMvhd(byte[] data, int start, int length, LongHolder duration) {
        if (length < 20) {
            return;
        }
        int version = data[start] & 0xff;
        long timescale;
        long value;
        if (version == 1) {
            if (length < 32) {
                return;
            }
            timescale = u32(data, start + 20);
            value = u64(data, start + 24);
        } else {
            timescale = u32(data, start + 12);
            value = u32(data, start + 16);
        }
        if (timescale <= 0 || value <= 0) {
            return;
        }
        long millis = Math.round(value * 1000.0 / timescale);
        duration.value = millis;
    }

    private static void parseIlst(byte[] data, int start, int end, int depth, MutableTags tags,
                                  ArtworkHolder artwork) {
        if (depth > MAX_DEPTH) {
            return;
        }
        int offset = start;
        int count = 0;
        while (offset + 8 <= end && count++ < MAX_BOXES) {
            long size = u32(data, offset);
            String key = ArtworkImages.ascii(data, offset + 4, 4);
            int headerLength = 8;
            int body = offset + 8;
            if (size == 1) {
                if (offset + 16 > end) {
                    return;
                }
                size = u64(data, offset + 8);
                headerLength = 16;
                body = offset + 16;
            } else if (size == 0) {
                size = end - offset;
            }
            if (size < headerLength || size > end - offset) {
                return;
            }
            int bodyLength = (int) (size - headerLength);
            parseIlstItem(data, key, body, body + bodyLength, tags, artwork);
            offset += (int) size;
        }
    }

    private static void parseIlstItem(byte[] data, String key, int start, int end,
                                      MutableTags tags, ArtworkHolder artwork) {
        int offset = start;
        int count = 0;
        while (offset + 8 <= end && count++ < MAX_BOXES) {
            long size = u32(data, offset);
            String type = ArtworkImages.ascii(data, offset + 4, 4);
            int headerLength = 8;
            int body = offset + 8;
            if (size == 1) {
                if (offset + 16 > end) {
                    return;
                }
                size = u64(data, offset + 8);
                headerLength = 16;
                body = offset + 16;
            } else if (size == 0) {
                size = end - offset;
            }
            if (size < headerLength || size > end - offset) {
                return;
            }
            int bodyLength = (int) (size - headerLength);
            // "data" is a full box: 4-byte type indicator + 4-byte locale + payload.
            if ("data".equals(type) && bodyLength >= 8) {
                int payloadStart = body + 8;
                int payloadLength = bodyLength - 8;
                if (payloadLength > MAX_TEXT_FRAME_BYTES && !"covr".equals(key)) {
                    return;
                }
                handleIlstData(data, key, payloadStart, payloadLength, tags, artwork);
            }
            offset += (int) size;
        }
    }

    private static void handleIlstData(byte[] data, String key, int start, int length,
                                       MutableTags tags, ArtworkHolder artwork) {
        switch (key) {
            case "\u00a9nam" -> tags.title = firstNonNull(tags.title,
                    sanitizeText(mp4Text(data, start, length), 255));
            case "\u00a9ART" -> tags.artist = firstNonNull(tags.artist,
                    sanitizeText(mp4Text(data, start, length), 255));
            case "\u00a9alb" -> tags.album = firstNonNull(tags.album,
                    sanitizeText(mp4Text(data, start, length), 255));
            case "\u00a9day" -> tags.year = firstNonNull(tags.year,
                    cleanYear(mp4Text(data, start, length)));
            case "\u00a9gen" -> tags.genre = firstNonNull(tags.genre,
                    cleanGenre(mp4Text(data, start, length)));
            case "gnre" -> {
                if (tags.genre == null && length >= 2) {
                    int index = (int) u16(data, start) - 1;
                    tags.genre = genreAt(index);
                }
            }
            case "covr" -> {
                if (artwork.value == null && length > 0 && length <= MAX_ARTWORK_BYTES) {
                    byte[] image = Arrays.copyOfRange(data, start, start + length);
                    String mime = ArtworkImages.sniffMimeType(image);
                    if (mime != null) {
                        artwork.value = new AudioMetadata.Artwork(mime, image);
                    }
                }
            }
            default -> {
                // Unknown item; never exposed.
            }
        }
    }

    private static String mp4Text(byte[] data, int start, int length) {
        if (length <= 0 || start < 0 || start + length > data.length) {
            return null;
        }
        int end = start + length;
        while (end > start && data[end - 1] == 0) {
            end--;
        }
        if (end <= start) {
            return null;
        }
        return new String(data, start, end - start, StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------
    // Shared helpers
    // ------------------------------------------------------------------

    private static AudioMetadata build(Long durationMs, String title, String artist,
                                       String album, String year, String genre,
                                       AudioMetadata.Artwork artwork) {
        return new AudioMetadata(clampDuration(durationMs), title, artist, album, year, genre,
                artwork);
    }

    private static Long clampDuration(Long durationMs) {
        if (durationMs == null || durationMs < 1) {
            return null;
        }
        return Math.min(durationMs, MediaMetadata.MAX_DURATION_MS);
    }

    private static Long cleanDuration(String value) {
        if (value == null) {
            return null;
        }
        String digits = value.strip();
        if (!digits.matches("\\d{1,12}")) {
            return null;
        }
        try {
            return clampDuration(Long.parseLong(digits));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static String cleanYear(String value) {
        if (value == null) {
            return null;
        }
        Matcher matcher = YEAR_PATTERN.matcher(value);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String cleanGenre(String value) {
        if (value == null) {
            return null;
        }
        String cleaned = value.replaceFirst("^\\(\\d+\\)", "").strip();
        if (cleaned.matches("\\d{1,3}")) {
            String genre = genreAt(Integer.parseInt(cleaned) - 1);
            if (genre != null) {
                return genre;
            }
        }
        return sanitizeText(cleaned, 64);
    }

    private static String genreAt(int index) {
        if (index < 0 || index >= GENRES.length) {
            return null;
        }
        return GENRES[index];
    }

    /**
     * Display sanitizer mirroring {@code frontend/src/files/id3.ts}: forbidden characters
     * become spaces, whitespace collapses, the result is trimmed and bounded by code points.
     * The server's {@link MediaMetadata} validator therefore accepts the parsed value instead
     * of rejecting the whole upload on a hostile tag.
     */
    static String sanitizeText(String value, int maxLength) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        StringBuilder cleaned = new StringBuilder(value.length());
        value.codePoints().forEach(codePoint -> {
            boolean forbidden = codePoint == '<' || codePoint == '>'
                    || codePoint <= 0x1f
                    || (codePoint >= 0x7f && codePoint <= 0x9f)
                    || (codePoint >= 0x202a && codePoint <= 0x202e)
                    || (codePoint >= 0x2066 && codePoint <= 0x2069)
                    || codePoint == 0x200e || codePoint == 0x200f
                    || codePoint == 0xfeff;
            cleaned.appendCodePoint(forbidden ? ' ' : codePoint);
        });
        String collapsed = cleaned.toString().replaceAll("\\s+", " ").strip();
        if (collapsed.isEmpty()) {
            return null;
        }
        if (collapsed.codePointCount(0, collapsed.length()) <= maxLength) {
            return collapsed;
        }
        int end = collapsed.offsetByCodePoints(0, maxLength);
        String truncated = collapsed.substring(0, end).strip();
        return truncated.isEmpty() ? null : truncated;
    }

    private static int findTerminator(byte[] bytes, int start, int step, int limit) {
        int end = Math.min(bytes.length, limit);
        for (int index = start; index + step <= end; index += step) {
            boolean zero = true;
            for (int offset = 0; offset < step; offset++) {
                if (bytes[index + offset] != 0) {
                    zero = false;
                    break;
                }
            }
            if (zero) {
                return index;
            }
        }
        return -1;
    }

    private static boolean isPadding(byte[] body, int offset) {
        return body[offset] == 0 && body[offset + 1] == 0 && body[offset + 2] == 0;
    }

    private static boolean isId3(byte[] head) {
        return head.length >= 3 && head[0] == 'I' && head[1] == 'D' && head[2] == '3';
    }

    private static boolean isMp4(byte[] head) {
        return head.length >= 12 && ArtworkImages.ascii(head, 4, 4).equals("ftyp");
    }

    private static boolean isMpegSync(byte[] head) {
        return head.length >= 2 && (head[0] & 0xff) == 0xff && (head[1] & 0xe0) == 0xe0;
    }

    private static int readAtMost(InputStream in, byte[] buffer, int length) throws IOException {
        int total = 0;
        while (total < length) {
            int read = in.read(buffer, total, length - total);
            if (read < 0) {
                break;
            }
            total += read;
        }
        return total;
    }

    private static long skipFully(InputStream in, long length) throws IOException {
        long remaining = length;
        while (remaining > 0) {
            long skipped = in.skip(remaining);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    break;
                }
                skipped = 1;
            }
            remaining -= skipped;
        }
        return length - remaining;
    }

    private static long u16(byte[] bytes, int offset) {
        if (offset < 0 || offset + 2 > bytes.length) {
            return 0;
        }
        return ((long) (bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
    }

    private static long u24(byte[] bytes, int offset) {
        if (offset < 0 || offset + 3 > bytes.length) {
            return 0;
        }
        return ((long) (bytes[offset] & 0xff) << 16)
                | ((long) (bytes[offset + 1] & 0xff) << 8)
                | (bytes[offset + 2] & 0xff);
    }

    private static long u32(byte[] bytes, int offset) {
        if (offset < 0 || offset + 4 > bytes.length) {
            return 0;
        }
        return ((long) (bytes[offset] & 0xff) << 24)
                | ((long) (bytes[offset + 1] & 0xff) << 16)
                | ((long) (bytes[offset + 2] & 0xff) << 8)
                | (bytes[offset + 3] & 0xff);
    }

    private static long u64(byte[] bytes, int offset) {
        if (offset < 0 || offset + 8 > bytes.length) {
            return -1;
        }
        long high = u32(bytes, offset);
        long low = u32(bytes, offset + 4);
        if ((high & 0x8000_0000L) != 0) {
            // A size/duration that large is invalid for a real upload; fail closed.
            return -1;
        }
        return (high << 32) | low;
    }

    private static String firstNonNull(String current, String candidate) {
        return current != null ? current : candidate;
    }

    private record FrameHeader(int version, int layer, int bitrateBps, int sampleRate,
                               int channelMode, boolean padding) {
    }

    private static final class MutableTags {
        private Long durationMs;
        private String title;
        private String artist;
        private String album;
        private String year;
        private String genre;
    }

    private static final class ArtworkHolder {
        private AudioMetadata.Artwork value;
    }

    private static final class LongHolder {
        private Long value;
    }
}
