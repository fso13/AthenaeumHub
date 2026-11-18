package ru.krug.backend.file.api.dto;

import java.util.List;
import java.util.UUID;

public record PreflightRequest(UUID chatId, List<PreflightFileRequest> files) {
}
