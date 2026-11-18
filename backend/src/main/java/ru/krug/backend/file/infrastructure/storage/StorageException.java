package ru.krug.backend.file.infrastructure.storage;

/** Object storage failure. Wrapped by the API layer as 500 and logged without payload. */
public class StorageException extends RuntimeException {

    public StorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
