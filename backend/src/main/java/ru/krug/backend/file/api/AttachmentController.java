package ru.krug.backend.file.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.file.api.dto.DownloadUrlResponse;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.usecase.AttachmentDownloadHandler;
import ru.krug.backend.shared.application.model.Principal;

/** Presigned GET URL, TTL 5 minutes (contract /attachments/{id}/download-url). */
@RestController
@RequestMapping("/api/v1/attachments/{attachmentId}/download-url")
public class AttachmentController {

    private final AttachmentDownloadHandler handler;

    public AttachmentController(AttachmentDownloadHandler handler) {
        this.handler = handler;
    }

    @GetMapping
    public DownloadUrlResponse downloadUrl(@PathVariable UUID attachmentId, Principal principal) {
        return FileApiMapper.toResponse(handler.downloadUrl(principal, attachmentId));
    }
}
