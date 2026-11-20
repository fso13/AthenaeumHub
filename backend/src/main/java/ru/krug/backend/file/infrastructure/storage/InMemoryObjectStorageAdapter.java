package ru.krug.backend.file.infrastructure.storage;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.model.Sha256;

/**
 * In-memory S3 stand-in for the test profile. It implements the same multipart contract
 * (create/part/complete/abort/presign) so integration tests exercise the real pipeline
 * without Docker-in-Docker object storage. Never enabled outside tests/dev memory mode.
 */
@Component
@ConditionalOnProperty(name = "krug.files.storage", havingValue = "memory")
public class InMemoryObjectStorageAdapter implements ObjectStoragePort {

    private final Map<String, StoredObject> objects = new ConcurrentHashMap<>();
    private final Map<String, MultipartState> multiparts = new ConcurrentHashMap<>();
    private final String bucket;

    public InMemoryObjectStorageAdapter(
            ru.krug.backend.file.infrastructure.config.FilesProperties properties) {
        this.bucket = properties.getBucket();
    }

    @Override
    public Multipart createMultipart(String objectKey, String contentType) {
        String id = UUID.randomUUID().toString();
        multiparts.put(id, new MultipartState(objectKey, contentType));
        return new Multipart(id);
    }

    @Override
    public void putObject(String objectKey, byte[] content, String contentType) {
        objects.put(objectKey, new StoredObject(content.clone(), contentType));
    }

    @Override
    public String uploadPart(String objectKey, String multipartId, int partNo, byte[] content) {
        MultipartState state = multiparts.get(multipartId);
        if (state == null) {
            throw new StorageException("multipart upload not found", null);
        }
        state.parts.put(partNo, content.clone());
        return md5(content);
    }

    @Override
    public void completeMultipart(String objectKey, String multipartId, List<Part> parts) {
        MultipartState state = multiparts.get(multipartId);
        if (state == null) {
            throw new StorageException("multipart upload not found", null);
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (Part part : parts.stream().sorted(
                java.util.Comparator.comparingInt(Part::partNo)).toList()) {
            byte[] bytes = state.parts.get(part.partNo());
            if (bytes == null) {
                throw new StorageException("multipart part missing: " + part.partNo(), null);
            }
            output.writeBytes(bytes);
        }
        byte[] data = output.toByteArray();
        objects.put(objectKey, new StoredObject(data, state.contentType));
        multiparts.remove(multipartId);
    }

    @Override
    public void abortMultipart(String objectKey, String multipartId) {
        multiparts.remove(multipartId);
    }

    @Override
    public boolean exists(String objectKey) {
        return objects.containsKey(objectKey);
    }

    @Override
    public InputStream open(String objectKey) {
        StoredObject object = objects.get(objectKey);
        if (object == null) {
            throw new StorageException("object not found", null);
        }
        return new ByteArrayInputStream(object.data());
    }

    @Override
    public String sha256Hex(String objectKey) {
        StoredObject object = objects.get(objectKey);
        if (object == null) {
            throw new StorageException("object not found", null);
        }
        return Sha256.ofBytes(object.data()).value();
    }

    @Override
    public void delete(String objectKey) {
        objects.remove(objectKey);
    }

    @Override
    public PresignedUrl presignGet(String objectKey, Duration ttl, String filename,
                                   String contentType) {
        Instant expiresAt = Instant.now().plus(ttl);
        String disposition = "attachment; filename*=UTF-8''"
                + URLEncoder.encode(filename == null ? "file" : filename, StandardCharsets.UTF_8)
                .replace("+", "%20");
        String url = "memory://" + bucket + "/" + objectKey + "?expires="
                + expiresAt.getEpochSecond() + "&response-content-disposition="
                + URLEncoder.encode(disposition, StandardCharsets.UTF_8);
        return new PresignedUrl(url, expiresAt);
    }

    private static String md5(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(data));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private record StoredObject(byte[] data, String contentType) {
    }

    private static final class MultipartState {
        private final String objectKey;
        private final String contentType;
        private final Map<Integer, byte[]> parts = new ConcurrentHashMap<>();

        private MultipartState(String objectKey, String contentType) {
            this.objectKey = objectKey;
            this.contentType = contentType;
        }
    }
}
