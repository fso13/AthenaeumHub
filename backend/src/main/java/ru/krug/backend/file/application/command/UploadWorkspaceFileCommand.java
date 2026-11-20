package ru.krug.backend.file.application.command;

import java.io.InputStream;
import java.util.UUID;

/**
 * One multipart global-file upload (#83). The stream is read by the handler inside the
 * transaction; it is never buffered whole, so a large allowed file does not have to fit in
 * the heap. {@code sizeBytes} is the servlet-parsed part length and is verified against the
 * bytes actually stored.
 */
public record UploadWorkspaceFileCommand(
        UUID workspaceId,
        String filename,
        String mimeType,
        long sizeBytes,
        InputStream content) {
}
