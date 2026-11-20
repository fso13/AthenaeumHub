package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.exception.InvalidImageException;
import ru.krug.backend.file.domain.exception.UnsupportedFileTypeException;
import ru.krug.backend.file.domain.model.ImageFormat;
import ru.krug.backend.file.domain.model.ImageHeader;
import ru.krug.backend.file.domain.service.ImageHeaderParser;
import ru.krug.backend.support.TestImages;

/** #92: magic-byte detection, header dimensions and static-only policy. */
class ImageHeaderParserTest {

    @Test
    void readsPngDimensions() {
        ImageHeader header = ImageHeaderParser.parse(TestImages.png(3, 2));
        assertThat(header.format()).isEqualTo(ImageFormat.PNG);
        assertThat(header.width()).isEqualTo(3);
        assertThat(header.height()).isEqualTo(2);
    }

    @Test
    void readsJpegDimensionsThroughAppSegments() {
        ImageHeader header = ImageHeaderParser.parse(TestImages.jpeg(4, 3));
        assertThat(header.format()).isEqualTo(ImageFormat.JPEG);
        assertThat(header.width()).isEqualTo(4);
        assertThat(header.height()).isEqualTo(3);
    }

    @Test
    void exifSegmentDoesNotChangeDimensions() {
        ImageHeader header = ImageHeaderParser.parse(
                TestImages.jpegWithExif(6, 5, "SECRET-EXIF-VALUE"));
        assertThat(header.format()).isEqualTo(ImageFormat.JPEG);
        assertThat(header.width()).isEqualTo(6);
        assertThat(header.height()).isEqualTo(5);
    }

    @Test
    void readsAllWebpLayouts() {
        assertThat(ImageHeaderParser.parse(TestImages.webpLossy(5, 6)))
                .isEqualTo(new ImageHeader(ImageFormat.WEBP, 5, 6));
        assertThat(ImageHeaderParser.parse(TestImages.webpLossless(7, 8)))
                .isEqualTo(new ImageHeader(ImageFormat.WEBP, 7, 8));
        assertThat(ImageHeaderParser.parse(TestImages.webpExtended(9, 10, false)))
                .isEqualTo(new ImageHeader(ImageFormat.WEBP, 9, 10));
    }

    @Test
    void rejectsAnimatedPng() {
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.apng(4, 4)))
                .isInstanceOf(InvalidImageException.class)
                .hasMessageContaining("Image is invalid");
    }

    @Test
    void rejectsAnimatedWebp() {
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.webpExtended(4, 4, true)))
                .isInstanceOf(InvalidImageException.class);
    }

    @Test
    void rejectsGifAndSvgAndUnknownMagic() {
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.gif()))
                .isInstanceOf(UnsupportedFileTypeException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.svg()))
                .isInstanceOf(UnsupportedFileTypeException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse("not an image".getBytes()))
                .isInstanceOf(UnsupportedFileTypeException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(new byte[0]))
                .isInstanceOf(InvalidImageException.class);
    }

    @Test
    void rejectsTruncatedHeadersAndImpossibleDimensions() {
        byte[] png = TestImages.png(4, 4);
        assertThatThrownBy(() -> ImageHeaderParser.parse(
                java.util.Arrays.copyOf(png, 20)))
                .isInstanceOf(InvalidImageException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(
                java.util.Arrays.copyOf(TestImages.jpeg(4, 4), 8)))
                .isInstanceOf(InvalidImageException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.png(16385, 8)))
                .isInstanceOf(InvalidImageException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(TestImages.pngWithDimensions(0, 8)))
                .isInstanceOf(InvalidImageException.class);
        assertThatThrownBy(() -> ImageHeaderParser.parse(
                TestImages.pngWithDimensions(10000, 10000)))
                .isInstanceOf(InvalidImageException.class);
    }

    @Test
    void acceptsPngWithTrailingBytes() {
        byte[] padded = TestImages.padded(TestImages.png(3, 3), 5 * 1024 * 1024);
        ImageHeader header = ImageHeaderParser.parse(padded);
        assertThat(header).isEqualTo(new ImageHeader(ImageFormat.PNG, 3, 3));
    }
}
