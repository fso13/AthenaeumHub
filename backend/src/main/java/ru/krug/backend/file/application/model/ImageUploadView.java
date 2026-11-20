package ru.krug.backend.file.application.model;

import java.util.UUID;

/** Safe response of {@code POST /media/images}: no filename, object key, hash or metadata. */
public record ImageUploadView(UUID fileId, int width, int height, String mime, long size) {
}
