package ru.krug.backend.shared.api;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;

public final class RequestHeaders {

    private RequestHeaders() {
    }

    /**
     * API-level parsing of a required UUID header. The application receives a typed UUID.
     */
    public static UUID requireUuid(String value, String headerName) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest(headerName + " header is required",
                    Map.of("header", headerName, "reason", "missing"));
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest(headerName + " header must be a UUID",
                    Map.of("header", headerName, "reason", "invalid_uuid"));
        }
    }
}
