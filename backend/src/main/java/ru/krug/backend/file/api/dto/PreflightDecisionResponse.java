package ru.krug.backend.file.api.dto;

import java.util.Map;

public record PreflightDecisionResponse(
        String name,
        boolean allowed,
        String error,
        Map<String, Object> details,
        Integer partSize) {
}
