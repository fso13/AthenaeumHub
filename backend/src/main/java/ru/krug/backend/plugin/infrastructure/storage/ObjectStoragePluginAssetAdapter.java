package ru.krug.backend.plugin.infrastructure.storage;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.plugin.application.port.PluginAssetStoragePort;
import ru.krug.backend.plugin.application.port.PluginPackageInvalidException;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Stores plugin assets through the existing S3/MinIO multipart port. A one-part multipart
 * upload keeps the same adapter contract as regular file uploads (memory mode included in
 * tests) without adding a second storage client.
 */
@Component
public class ObjectStoragePluginAssetAdapter implements PluginAssetStoragePort {

    private final ObjectStoragePort storage;

    public ObjectStoragePluginAssetAdapter(ObjectStoragePort storage) {
        this.storage = storage;
    }

    @Override
    public void put(String objectKey, byte[] content, String contentType) {
        try {
            ObjectStoragePort.Multipart multipart =
                    storage.createMultipart(objectKey, contentType);
            String etag = storage.uploadPart(objectKey, multipart.uploadId(), 1, content);
            storage.completeMultipart(objectKey, multipart.uploadId(),
                    List.of(new ObjectStoragePort.Part(1, etag)));
        } catch (RuntimeException ex) {
            throw DomainException.serviceUnavailable(ErrorCode.PLUGIN_STORAGE_UNAVAILABLE,
                    "Plugin package storage is unavailable", java.util.Map.of(), 30L);
        }
    }

    @Override
    public byte[] read(String objectKey, long maxBytes) {
        try (InputStream input = storage.open(objectKey)) {
            byte[] content = input.readNBytes((int) Math.min(maxBytes + 1, Integer.MAX_VALUE));
            if (content.length > maxBytes) {
                throw new PluginPackageInvalidException("stored asset is too large");
            }
            return content;
        } catch (IOException ex) {
            throw DomainException.serviceUnavailable(ErrorCode.PLUGIN_STORAGE_UNAVAILABLE,
                    "Plugin package storage is unavailable", java.util.Map.of(), 30L);
        } catch (RuntimeException ex) {
            if (ex instanceof DomainException || ex instanceof PluginPackageInvalidException) {
                throw ex;
            }
            throw DomainException.serviceUnavailable(ErrorCode.PLUGIN_STORAGE_UNAVAILABLE,
                    "Plugin package storage is unavailable", java.util.Map.of(), 30L);
        }
    }

    @Override
    public void delete(String objectKey) {
        storage.delete(objectKey);
    }
}
