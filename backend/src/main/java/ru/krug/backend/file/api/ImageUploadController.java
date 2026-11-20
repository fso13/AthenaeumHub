package ru.krug.backend.file.api;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ru.krug.backend.file.api.dto.ImageUploadResponse;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.command.UploadImageCommand;
import ru.krug.backend.file.application.model.ImageUploadView;
import ru.krug.backend.file.application.usecase.DirectImageUploadHandler;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /media/images} (#92): direct device upload for avatars, channel covers/avatars
 * and workspace logos. Multipart part {@code file} plus optional {@code chat_id}; the
 * response is the safe attachment id + intrinsic dimensions (no filename/key/EXIF).
 */
@RestController
@RequestMapping("/api/v1/media")
public class ImageUploadController {

    private final DirectImageUploadHandler handler;

    public ImageUploadController(DirectImageUploadHandler handler) {
        this.handler = handler;
    }

    @PostMapping(value = "/images", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ImageUploadResponse> upload(
            @RequestPart("file") MultipartFile file,
            @RequestParam(value = "chat_id", required = false) UUID chatId,
            Principal principal) {
        // The servlet multipart limit is a backstop; check before buffering the body so the
        // 413 envelope is the documented FILE_TOO_LARGE rather than the plugin-specific code.
        if (file.getSize() > DirectImageUploadHandler.MAX_IMAGE_BYTES) {
            throw DomainException.payloadTooLarge(ErrorCode.FILE_TOO_LARGE,
                    "Image exceeds the 5 MiB limit",
                    Map.of("limit", DirectImageUploadHandler.MAX_IMAGE_BYTES,
                            "actual", file.getSize()));
        }
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException ex) {
            throw DomainException.badRequest("Uploaded file cannot be read",
                    Map.of("field", "file"));
        }
        ImageUploadView view = handler.upload(principal,
                new UploadImageCommand(chatId, file.getOriginalFilename(), file.getContentType(),
                        bytes));
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(FileApiMapper.toResponse(view));
    }
}
