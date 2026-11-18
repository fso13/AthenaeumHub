package ru.krug.backend.file.infrastructure.storage;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.infrastructure.config.FilesProperties;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.core.sync.ResponseTransformer;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.AbortMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.CompleteMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.CompletedMultipartUpload;
import software.amazon.awssdk.services.s3.model.CompletedPart;
import software.amazon.awssdk.services.s3.model.CreateMultipartUploadRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchBucketException;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.UploadPartRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PresignedGetObjectRequest;

/**
 * Real S3/MinIO adapter. Multipart parts arrive through the API (E4-D-02); downloads are
 * presigned GET URLs with a 5 minute TTL. Path-style addressing is required by MinIO.
 */
@Component
@ConditionalOnProperty(name = "krug.files.storage", havingValue = "s3", matchIfMissing = true)
public class S3ObjectStorageAdapter implements ObjectStoragePort {

    private static final Logger log = LoggerFactory.getLogger(S3ObjectStorageAdapter.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final FilesProperties properties;
    private final AtomicBoolean bucketChecked = new AtomicBoolean(false);

    public S3ObjectStorageAdapter(S3Client s3, S3Presigner presigner,
                                  FilesProperties properties) {
        this.s3 = s3;
        this.presigner = presigner;
        this.properties = properties;
    }

    @Override
    public Multipart createMultipart(String objectKey, String contentType) {
        ensureBucket();
        try {
            return new Multipart(s3.createMultipartUpload(CreateMultipartUploadRequest.builder()
                    .bucket(properties.getBucket())
                    .key(objectKey)
                    .contentType(contentType)
                    .build()).uploadId());
        } catch (S3Exception ex) {
            throw new StorageException("create multipart failed", ex);
        }
    }

    @Override
    public String uploadPart(String objectKey, String multipartId, int partNo, byte[] content) {
        try {
            return s3.uploadPart(UploadPartRequest.builder()
                            .bucket(properties.getBucket())
                            .key(objectKey)
                            .uploadId(multipartId)
                            .partNumber(partNo)
                            .contentLength((long) content.length)
                            .build(),
                    RequestBody.fromBytes(content)).eTag();
        } catch (S3Exception ex) {
            throw new StorageException("upload part failed", ex);
        }
    }

    @Override
    public void completeMultipart(String objectKey, String multipartId, List<Part> parts) {
        List<CompletedPart> completed = parts.stream()
                .sorted(Comparator.comparingInt(Part::partNo))
                .map(part -> CompletedPart.builder()
                        .partNumber(part.partNo())
                        .eTag(part.etag())
                        .build())
                .toList();
        try {
            s3.completeMultipartUpload(CompleteMultipartUploadRequest.builder()
                    .bucket(properties.getBucket())
                    .key(objectKey)
                    .uploadId(multipartId)
                    .multipartUpload(CompletedMultipartUpload.builder().parts(completed).build())
                    .build());
        } catch (S3Exception ex) {
            throw new StorageException("complete multipart failed", ex);
        }
    }

    @Override
    public void abortMultipart(String objectKey, String multipartId) {
        try {
            s3.abortMultipartUpload(AbortMultipartUploadRequest.builder()
                    .bucket(properties.getBucket())
                    .key(objectKey)
                    .uploadId(multipartId)
                    .build());
        } catch (S3Exception ex) {
            throw new StorageException("abort multipart failed", ex);
        }
    }

    @Override
    public boolean exists(String objectKey) {
        try {
            s3.headObject(HeadObjectRequest.builder()
                    .bucket(properties.getBucket()).key(objectKey).build());
            return true;
        } catch (S3Exception ex) {
            if (ex.statusCode() == 404) {
                return false;
            }
            throw new StorageException("head object failed", ex);
        }
    }

    @Override
    public InputStream open(String objectKey) {
        try {
            return s3.getObject(GetObjectRequest.builder()
                            .bucket(properties.getBucket()).key(objectKey).build(),
                    ResponseTransformer.toInputStream());
        } catch (S3Exception ex) {
            throw new StorageException("get object failed", ex);
        }
    }

    @Override
    public String sha256Hex(String objectKey) {
        try (InputStream input = open(objectKey);
             DigestInputStream digest = new DigestInputStream(input,
                     MessageDigest.getInstance("SHA-256"))) {
            digest.transferTo(java.io.OutputStream.nullOutputStream());
            return HexFormat.of().formatHex(digest.getMessageDigest().digest());
        } catch (IOException | NoSuchAlgorithmException ex) {
            throw new StorageException("hash object failed", ex);
        }
    }

    @Override
    public void delete(String objectKey) {
        try {
            s3.deleteObject(DeleteObjectRequest.builder()
                    .bucket(properties.getBucket()).key(objectKey).build());
        } catch (S3Exception ex) {
            throw new StorageException("delete object failed", ex);
        }
    }

    @Override
    public PresignedUrl presignGet(String objectKey, Duration ttl, String filename,
                                   String contentType) {
        String disposition = "attachment; filename*=UTF-8''"
                + URLEncoder.encode(filename == null ? "file" : filename, StandardCharsets.UTF_8)
                .replace("+", "%20");
        GetObjectRequest request = GetObjectRequest.builder()
                .bucket(properties.getBucket())
                .key(objectKey)
                .responseContentDisposition(disposition)
                .responseContentType(contentType == null
                        ? "application/octet-stream" : contentType)
                .build();
        try {
            PresignedGetObjectRequest presigned = presigner.presignGetObject(
                    GetObjectPresignRequest.builder()
                            .signatureDuration(ttl)
                            .getObjectRequest(request)
                            .build());
            Instant expiresAt = presigned.expiration() == null
                    ? Instant.now().plus(ttl) : presigned.expiration();
            return new PresignedUrl(presigned.url().toString(), expiresAt);
        } catch (RuntimeException ex) {
            throw new StorageException("presign failed", ex);
        }
    }

    private void ensureBucket() {
        if (bucketChecked.get()) {
            return;
        }
        synchronized (bucketChecked) {
            if (bucketChecked.get()) {
                return;
            }
            try {
                s3.headBucket(HeadBucketRequest.builder()
                        .bucket(properties.getBucket()).build());
            } catch (NoSuchBucketException ex) {
                s3.createBucket(builder -> builder.bucket(properties.getBucket()));
                log.info("file.storage.bucket_created bucket={}", properties.getBucket());
            } catch (S3Exception ex) {
                // MinIO answers 404 for a missing bucket; create it. Other errors surface on
                // the first real operation with full context.
                if (ex.statusCode() == 404) {
                    s3.createBucket(builder -> builder.bucket(properties.getBucket()));
                } else {
                    log.warn("file.storage.bucket_check_failed status={}", ex.statusCode());
                }
            }
            bucketChecked.set(true);
        }
    }

}
