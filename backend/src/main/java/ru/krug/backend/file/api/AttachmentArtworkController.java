package ru.krug.backend.file.api;

import java.time.Duration;
import java.util.UUID;

import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.file.application.model.AttachmentArtworkView;
import ru.krug.backend.file.application.usecase.AttachmentArtworkHandler;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /api/v1/attachments/{attachmentId}/artwork} (#97): the private, authenticated
 * cover extracted from an uploaded AUDIO file.
 *
 * <p>The response is the stored bytes only, with a sniffed static-raster content type and
 * {@code nosniff}; never a redirect or a presigned MinIO URL. AV and visibility follow the
 * download endpoint (PENDING 409, quarantined 423, foreign attachment 404).
 */
@RestController
@RequestMapping("/api/v1/attachments/{attachmentId}/artwork")
public class AttachmentArtworkController {

    private final AttachmentArtworkHandler handler;

    public AttachmentArtworkController(AttachmentArtworkHandler handler) {
        this.handler = handler;
    }

    @GetMapping
    public ResponseEntity<byte[]> artwork(@PathVariable UUID attachmentId,
                                          Principal principal) {
        AttachmentArtworkView view = handler.artwork(principal, attachmentId);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(view.mimeType()))
                .contentLength(view.content().length)
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(10)).cachePrivate())
                .header("X-Content-Type-Options", "nosniff")
                .body(view.content());
    }
}
