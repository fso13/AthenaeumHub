package ru.krug.backend.support;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import javax.imageio.ImageIO;

/**
 * Deterministic image fixtures for #92. PNG/JPEG are produced by the JDK encoder (real
 * files); WebP and APNG are assembled from the documented headers because the JDK has no
 * WebP writer. No test depends on external files or network.
 */
public final class TestImages {

    private TestImages() {
    }

    public static byte[] png(int width, int height) {
        return encode("png", width, height);
    }

    public static byte[] jpeg(int width, int height) {
        return encode("jpg", width, height);
    }

    /** JPEG with an APP1/EXIF segment containing a recognizable marker (must never leak). */
    public static byte[] jpegWithExif(int width, int height, String marker) {
        byte[] jpeg = jpeg(width, height);
        byte[] payload = ("Exif\0\0" + marker).getBytes(StandardCharsets.ISO_8859_1);
        int length = payload.length + 2;
        byte[] result = new byte[jpeg.length + payload.length + 4];
        result[0] = jpeg[0];
        result[1] = jpeg[1];
        result[2] = (byte) 0xFF;
        result[3] = (byte) 0xE1;
        result[4] = (byte) (length >>> 8);
        result[5] = (byte) length;
        System.arraycopy(payload, 0, result, 6, payload.length);
        System.arraycopy(jpeg, 2, result, 6 + payload.length, jpeg.length - 2);
        return result;
    }

    public static byte[] webpLossy(int width, int height) {
        byte[] data = new byte[10];
        data[3] = (byte) 0x9D;
        data[4] = 0x01;
        data[5] = 0x2A;
        putU16le(data, 6, width & 0x3FFF);
        putU16le(data, 8, height & 0x3FFF);
        return riff("VP8 ", data);
    }

    public static byte[] webpLossless(int width, int height) {
        byte[] data = new byte[5];
        data[0] = 0x2F;
        long bits = ((long) (width - 1) & 0x3FFF)
                | (((long) (height - 1) & 0x3FFF) << 14);
        putU32le(data, 1, bits);
        return riff("VP8L", data);
    }

    public static byte[] webpExtended(int width, int height, boolean animated) {
        byte[] data = new byte[10];
        data[0] = (byte) (animated ? 0x02 : 0x00);
        putU24le(data, 4, width - 1);
        putU24le(data, 7, height - 1);
        return riff("VP8X", data);
    }

    /** APNG: a valid PNG signature/IHDR followed by the animation control chunk. */
    public static byte[] apng(int width, int height) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
        out.writeBytes(chunk("IHDR", ihdr(width, height)));
        byte[] actl = new byte[8];
        putU32be(actl, 0, 2);
        out.writeBytes(chunk("acTL", actl));
        out.writeBytes(chunk("IDAT", new byte[0]));
        out.writeBytes(chunk("IEND", new byte[0]));
        return out.toByteArray();
    }

    /** PNG header with caller-chosen dimensions (used for zero/oversized boundary tests). */
    public static byte[] pngWithDimensions(int width, int height) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
        out.writeBytes(chunk("IHDR", ihdr(width, height)));
        out.writeBytes(chunk("IDAT", new byte[0]));
        out.writeBytes(chunk("IEND", new byte[0]));
        return out.toByteArray();
    }

    private static byte[] ihdr(int width, int height) {
        byte[] ihdr = new byte[13];
        putU32be(ihdr, 0, width);
        putU32be(ihdr, 4, height);
        ihdr[8] = 8;
        ihdr[9] = 6;
        return ihdr;
    }

    public static byte[] gif() {
        return new byte[] {'G', 'I', 'F', '8', '9', 'a', 1, 0, 1, 0, 0, 0, 0, 0x3B};
    }

    public static byte[] svg() {
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"></svg>"
                .getBytes(StandardCharsets.UTF_8);
    }

    /** Appends zero bytes after a valid image (PNG/JPEG parsers stop at the header). */
    public static byte[] padded(byte[] image, int targetSize) {
        byte[] result = Arrays.copyOf(image, targetSize);
        return result;
    }

    private static byte[] encode(String format, int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, format, out)) {
                throw new IllegalStateException("ImageIO has no writer for " + format);
            }
            return out.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("cannot encode test image", ex);
        }
    }

    private static byte[] riff(String fourcc, byte[] chunk) {
        byte[] result = new byte[20 + chunk.length];
        writeAscii(result, 0, "RIFF");
        putU32le(result, 4, result.length - 8);
        writeAscii(result, 8, "WEBP");
        writeAscii(result, 12, fourcc);
        putU32le(result, 16, chunk.length);
        System.arraycopy(chunk, 0, result, 20, chunk.length);
        return result;
    }

    private static byte[] chunk(String type, byte[] data) {
        byte[] result = new byte[12 + data.length];
        putU32be(result, 0, data.length);
        writeAscii(result, 4, type);
        System.arraycopy(data, 0, result, 8, data.length);
        // CRC is not validated by the header parser; zeroes keep the fixture minimal.
        return result;
    }

    private static void writeAscii(byte[] target, int offset, String value) {
        for (int index = 0; index < value.length(); index++) {
            target[offset + index] = (byte) value.charAt(index);
        }
    }

    private static void putU16le(byte[] target, int offset, int value) {
        target[offset] = (byte) value;
        target[offset + 1] = (byte) (value >>> 8);
    }

    private static void putU24le(byte[] target, int offset, int value) {
        target[offset] = (byte) value;
        target[offset + 1] = (byte) (value >>> 8);
        target[offset + 2] = (byte) (value >>> 16);
    }

    private static void putU32le(byte[] target, int offset, long value) {
        target[offset] = (byte) value;
        target[offset + 1] = (byte) (value >>> 8);
        target[offset + 2] = (byte) (value >>> 16);
        target[offset + 3] = (byte) (value >>> 24);
    }

    private static void putU32be(byte[] target, int offset, long value) {
        target[offset] = (byte) (value >>> 24);
        target[offset + 1] = (byte) (value >>> 16);
        target[offset + 2] = (byte) (value >>> 8);
        target[offset + 3] = (byte) value;
    }
}
