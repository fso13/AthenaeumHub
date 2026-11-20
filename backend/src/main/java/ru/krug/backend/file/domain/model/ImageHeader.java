package ru.krug.backend.file.domain.model;

/**
 * Dimensions and detected format read from the image header only. The server never decodes
 * the image, and the original bytes (including any EXIF/ICC metadata) are stored verbatim.
 */
public record ImageHeader(ImageFormat format, int width, int height) {

    public static final int MAX_DIMENSION = 16384;

    public ImageHeader {
        if (format == null) {
            throw new IllegalArgumentException("format is required");
        }
        if (width < 1 || width > MAX_DIMENSION || height < 1 || height > MAX_DIMENSION) {
            throw new IllegalArgumentException("image dimensions are out of range");
        }
    }
}
