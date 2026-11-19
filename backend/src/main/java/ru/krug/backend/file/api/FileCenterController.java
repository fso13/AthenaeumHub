package ru.krug.backend.file.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.file.api.dto.FilePageResponse;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.command.ListFilesQuery;
import ru.krug.backend.file.application.usecase.ListFilesService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /files} — workspace file center (#73). Returns attachment metadata only;
 * downloading still goes through {@code /attachments/{id}/download-url}.
 */
@RestController
@RequestMapping("/api/v1/files")
public class FileCenterController {

    private final ListFilesService listFilesService;

    public FileCenterController(ListFilesService listFilesService) {
        this.listFilesService = listFilesService;
    }

    @GetMapping
    public FilePageResponse list(
            @RequestParam(value = "workspace_id", required = false) UUID workspaceId,
            @RequestParam(value = "chat_id", required = false) UUID chatId,
            @RequestParam(value = "kind", required = false) String kind,
            @RequestParam(value = "scan_status", required = false) String scanStatus,
            @RequestParam(value = "query", required = false) String query,
            @RequestParam(value = "mime", required = false) String mime,
            @RequestParam(value = "extension", required = false) String extension,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return FileApiMapper.toResponse(listFilesService.list(new ListFilesQuery(principal,
                workspaceId, chatId, kind, scanStatus, query, mime, extension, cursor, limit)));
    }
}
