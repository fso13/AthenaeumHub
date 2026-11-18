package ru.krug.backend.file.application.model;

import ru.krug.backend.file.domain.model.UploadPart;

public record UploadPartView(int partNo, boolean received, String etag, long sizeBytes) {

    public static UploadPartView from(UploadPart part) {
        return new UploadPartView(part.partNo(), true, part.etag(), part.sizeBytes());
    }
}
