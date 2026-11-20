package ru.krug.backend.file.api.dto;

import java.util.UUID;

/**
 * Response of {@code POST /media/images}. Deliberately contains no filename, object key,
 * hash, EXIF or other source metadata: the client only needs the attachment id and the
 * dimensions it can render before the image is fetched.
 */
public record ImageUploadResponse(UUID fileId, int width, int height, String mime, long size) {
}
