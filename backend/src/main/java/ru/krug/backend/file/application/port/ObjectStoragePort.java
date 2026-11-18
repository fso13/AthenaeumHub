package ru.krug.backend.file.application.port;

import java.io.InputStream;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * S3-compatible object storage port. Parts are uploaded through the API in this slice
 * (E4-D-02); only downloads use a presigned URL. Adapters must be idempotent for repeated
 * part/complete/abort calls where S3 allows it.
 */
public interface ObjectStoragePort {

    Multipart createMultipart(String objectKey, String contentType);

    String uploadPart(String objectKey, String multipartId, int partNo, byte[] content);

    void completeMultipart(String objectKey, String multipartId, List<Part> parts);

    void abortMultipart(String objectKey, String multipartId);

    boolean exists(String objectKey);

    /** Streams the object; the caller closes it. Used by the ClamAV adapter. */
    InputStream open(String objectKey);

    /** SHA-256 of the stored object, streamed; used to verify the completed file. */
    String sha256Hex(String objectKey);

    void delete(String objectKey);

    PresignedUrl presignGet(String objectKey, Duration ttl, String filename, String contentType);

    record Multipart(String uploadId) {
    }

    record Part(int partNo, String etag) {
    }

    record PresignedUrl(String url, Instant expiresAt) {
    }
}
