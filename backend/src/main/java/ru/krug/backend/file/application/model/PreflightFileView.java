package ru.krug.backend.file.application.model;

import java.util.Map;

public record PreflightFileView(
        String name,
        boolean allowed,
        String error,
        Map<String, Object> details,
        Integer partSize) {

    public static PreflightFileView allowed(String name, int partSize) {
        return new PreflightFileView(name, true, null, Map.of(), partSize);
    }

    public static PreflightFileView denied(String name, String error, Map<String, Object> details) {
        return new PreflightFileView(name, false, error,
                details == null ? Map.of() : details, null);
    }
}
