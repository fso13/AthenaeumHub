package ru.krug.backend.shared.api.dto;

import java.util.Map;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Contract error envelope: {code, message, details, request_id}.
 */
public record ApiError(
        String code,
        String message,
        Map<String, Object> details,
        @JsonProperty("request_id") String requestId) {
}
