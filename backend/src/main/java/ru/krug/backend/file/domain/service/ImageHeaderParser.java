package ru.krug.backend.file.domain.service;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

import ru.krug.backend.file.domain.exception.InvalidImageException;
import ru.krug.backend.file.domain.exception.UnsupportedFileTypeException;
import ru.krug.backend.file.domain.model.ImageFormat;
import ru.krug.backend.file.domain.model.ImageHeader;

/**
 * Dependency-free header parser for the trusted direct-image pipeline.
 *
 * <p>It performs three jobs in one pass and never decodes pixel data:
 * <ol>
 *   <li>detect the real format from magic bytes (the client {@code Content-Type} is not
 *       trusted) and reject everything except PNG, JPEG and WebP;</li>
 *   <li>read the intrinsic dimensions (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X);</li>
 *   <li>reject animated variants (APNG {@code acTL}, animated WebP) because only static
 *       images are allowed for avatars/covers/logos.</li>
 * </ol>
 *
 * <p>The original bytes are stored verbatim, so this parser is the only place that touches
 * the image structure. It is pure domain code: no I/O, no image libraries, bounded reads and
 * no loops that an attacker can make unbounded beyond the already size-capped byte array.
 */
public final class ImageHeaderParser {

    private static final byte[] PNG_SIGNATURE = {
            (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A
    };
    private static final List<String> ALLOWED = List.of(
            ImageFormat.PNG.mime(), ImageFormat.JPEG.mime(), ImageFormat.WEBP.mime());
    /** Decode-amplification bound for a 5 MiB avatar/cover/logo (40 MP > 8K). */
    private static final long MAX_PIXELS = 40_000_000L;

    private ImageHeaderParser() {
    }

    /**
     * @throws UnsupportedFileTypeException 415 for anything that is not PNG/JPEG/WebP
     * @throws InvalidImageException 422 for a malformed, truncated, oversized or animated image
     */
    public static ImageHeader parse(byte[] data) {
        if (data == null || data.length < 12) {
            throw new InvalidImageException("truncated");
        }
        if (startsWith(data, PNG_SIGNATURE)) {
            return parsePng(data);
        }
        if ((data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return parseJpeg(data);
        }
        if (isWebp(data)) {
            return parseWebp(data);
        }
        if (startsWithAscii(data, "GIF87a") || startsWithAscii(data, "GIF89a")) {
            throw new UnsupportedFileTypeException("image/gif", ALLOWED);
        }
        if (looksLikeSvg(data)) {
            throw new UnsupportedFileTypeException("image/svg+xml", ALLOWED);
        }
        throw new UnsupportedFileTypeException("unknown", ALLOWED);
    }

    private static ImageHeader parsePng(byte[] data) {
        if (data.length < 33) {
            throw new InvalidImageException("png_truncated");
        }
        int offset = PNG_SIGNATURE.length;
        Integer width = null;
        Integer height = null;
        boolean first = true;
        while (offset + 8 <= data.length) {
            long length = u32be(data, offset);
            String type = new String(data, offset + 4, 4, StandardCharsets.US_ASCII);
            long dataStart = (long) offset + 8;
            long dataEnd = dataStart + length;
            if (length < 0 || dataEnd + 4 > data.length) {
                throw new InvalidImageException("png_chunk_truncated");
            }
            if (first) {
                if (!"IHDR".equals(type) || length != 13) {
                    throw new InvalidImageException("png_ihdr_missing");
                }
                width = (int) u32be(data, (int) dataStart);
                height = (int) u32be(data, (int) dataStart + 4);
                first = false;
            } else if ("acTL".equals(type)) {
                // APNG animation control chunk; only static PNG is allowed.
                throw new InvalidImageException("animated_not_supported",
                        java.util.Map.of("format", "png"));
            } else if ("IDAT".equals(type) || "IEND".equals(type)) {
                break;
            }
            offset = (int) (dataEnd + 4);
        }
        if (width == null || height == null) {
            throw new InvalidImageException("png_dimensions_missing");
        }
        return header(ImageFormat.PNG, width, height);
    }

    private static ImageHeader parseJpeg(byte[] data) {
        int offset = 2;
        while (offset + 1 < data.length) {
            if ((data[offset] & 0xFF) != 0xFF) {
                throw new InvalidImageException("jpeg_marker_expected");
            }
            while (offset < data.length && (data[offset] & 0xFF) == 0xFF) {
                offset++;
            }
            if (offset >= data.length) {
                break;
            }
            int marker = data[offset++] & 0xFF;
            if (marker == 0x00 || marker == 0xD8) {
                continue;
            }
            if (marker == 0xD9 || marker == 0xDA) {
                break;
            }
            if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                continue;
            }
            if (offset + 2 > data.length) {
                throw new InvalidImageException("jpeg_segment_truncated");
            }
            int segmentLength = u16be(data, offset);
            if (segmentLength < 2 || offset + segmentLength > data.length) {
                throw new InvalidImageException("jpeg_segment_truncated");
            }
            if (isSof(marker)) {
                if (segmentLength < 7) {
                    throw new InvalidImageException("jpeg_sof_truncated");
                }
                int height = u16be(data, offset + 3);
                int width = u16be(data, offset + 5);
                return header(ImageFormat.JPEG, width, height);
            }
            offset += segmentLength;
        }
        throw new InvalidImageException("jpeg_dimensions_missing");
    }

    private static ImageHeader parseWebp(byte[] data) {
        if (data.length < 20) {
            throw new InvalidImageException("webp_truncated");
        }
        String chunk = new String(data, 12, 4, StandardCharsets.US_ASCII);
        long chunkSize = u32le(data, 16);
        int start = 20;
        if (start + chunkSize > data.length) {
            throw new InvalidImageException("webp_chunk_truncated");
        }
        switch (chunk) {
            case "VP8 " -> {
                if (chunkSize < 10
                        || (data[start + 3] & 0xFF) != 0x9D
                        || (data[start + 4] & 0xFF) != 0x01
                        || (data[start + 5] & 0xFF) != 0x2A) {
                    throw new InvalidImageException("webp_vp8_header_invalid");
                }
                int width = u16le(data, start + 6) & 0x3FFF;
                int height = u16le(data, start + 8) & 0x3FFF;
                return header(ImageFormat.WEBP, width, height);
            }
            case "VP8L" -> {
                if (chunkSize < 5 || (data[start] & 0xFF) != 0x2F) {
                    throw new InvalidImageException("webp_vp8l_header_invalid");
                }
                long bits = u32le(data, start + 1);
                int width = 1 + (int) (bits & 0x3FFF);
                int height = 1 + (int) ((bits >>> 14) & 0x3FFF);
                return header(ImageFormat.WEBP, width, height);
            }
            case "VP8X" -> {
                if (chunkSize < 10) {
                    throw new InvalidImageException("webp_vp8x_header_invalid");
                }
                int flags = data[start] & 0xFF;
                if ((flags & 0x02) != 0) {
                    throw new InvalidImageException("animated_not_supported",
                            java.util.Map.of("format", "webp"));
                }
                int width = 1 + (int) u24le(data, start + 4);
                int height = 1 + (int) u24le(data, start + 7);
                return header(ImageFormat.WEBP, width, height);
            }
            default -> throw new InvalidImageException("webp_layout_unsupported",
                    java.util.Map.of("chunk", chunk));
        }
    }

    private static ImageHeader header(ImageFormat format, int width, int height) {
        if (width < 1 || height < 1) {
            throw new InvalidImageException("dimensions_missing");
        }
        if (width > ImageHeader.MAX_DIMENSION || height > ImageHeader.MAX_DIMENSION
                || (long) width * height > MAX_PIXELS) {
            throw new InvalidImageException("dimensions_too_large",
                    java.util.Map.of("max", ImageHeader.MAX_DIMENSION,
                            "max_pixels", MAX_PIXELS));
        }
        return new ImageHeader(format, width, height);
    }

    private static boolean isWebp(byte[] data) {
        return data.length >= 12
                && startsWithAscii(data, "RIFF")
                && "WEBP".equals(new String(data, 8, 4, StandardCharsets.US_ASCII));
    }

    private static boolean isSof(int marker) {
        return switch (marker) {
            case 0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF -> true;
            default -> false;
        };
    }

    private static boolean startsWith(byte[] data, byte[] prefix) {
        if (data.length < prefix.length) {
            return false;
        }
        for (int index = 0; index < prefix.length; index++) {
            if (data[index] != prefix[index]) {
                return false;
            }
        }
        return true;
    }

    private static boolean startsWithAscii(byte[] data, String prefix) {
        if (data.length < prefix.length()) {
            return false;
        }
        for (int index = 0; index < prefix.length(); index++) {
            if ((data[index] & 0xFF) != prefix.charAt(index)) {
                return false;
            }
        }
        return true;
    }

    /** SVG is XML text; only a bounded prefix is inspected (no XML parsing). */
    private static boolean looksLikeSvg(byte[] data) {
        int limit = Math.min(data.length, 512);
        String prefix = new String(data, 0, limit, StandardCharsets.UTF_8)
                .stripLeading().toLowerCase(Locale.ROOT);
        return prefix.startsWith("<svg") || prefix.startsWith("<?xml")
                || prefix.contains("<svg");
    }

    private static int u16be(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    private static int u16le(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static long u24le(byte[] data, int offset) {
        return (data[offset] & 0xFFL)
                | ((data[offset + 1] & 0xFFL) << 8)
                | ((data[offset + 2] & 0xFFL) << 16);
    }

    private static long u32be(byte[] data, int offset) {
        return ((long) (data[offset] & 0xFF) << 24)
                | ((long) (data[offset + 1] & 0xFF) << 16)
                | ((long) (data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFFL);
    }

    private static long u32le(byte[] data, int offset) {
        return (data[offset] & 0xFFL)
                | ((long) (data[offset + 1] & 0xFF) << 8)
                | ((long) (data[offset + 2] & 0xFF) << 16)
                | ((long) (data[offset + 3] & 0xFF) << 24);
    }
}
