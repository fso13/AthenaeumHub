package ru.krug.backend.file.api;

import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ru.krug.backend.file.api.dto.FileItemResponse;
import ru.krug.backend.file.api.dto.FileRenameRequest;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.command.UploadWorkspaceFileCommand;
import ru.krug.backend.file.application.usecase.FileMutationService;
import ru.krug.backend.file.application.usecase.WorkspaceFileUploadHandler;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * Global workspace files (#83).
 *
 * <ul>
 *   <li>{@code POST /workspaces/{workspaceId}/files} — multipart upload of any allowed type.
 *       The same managed policy/AV pipeline as chat uploads; the file starts unbound and is
 *       visible to its owner (and to workspace OWNER/ADMIN for moderation).</li>
 *   <li>{@code PATCH /files/{fileId}} — owner rename.</li>
 *   <li>{@code DELETE /files/{fileId}} — owner/admin soft delete of an unbound file.</li>
 * </ul>
 *
 * <p>The multipart stream is handed to the application layer as an {@link InputStream}; it is
 * streamed into object storage in bounded chunks, never buffered whole in the heap.
 */
@RestController
@RequestMapping("/api/v1")
public class WorkspaceFileController {

    private final WorkspaceFileUploadHandler uploadHandler;
    private final FileMutationService mutationService;

    public WorkspaceFileController(WorkspaceFileUploadHandler uploadHandler,
                                   FileMutationService mutationService) {
        this.uploadHandler = uploadHandler;
        this.mutationService = mutationService;
    }

    @PostMapping(value = "/workspaces/{workspaceId}/files",
            consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<FileItemResponse> upload(
            @PathVariable UUID workspaceId,
            @RequestPart("file") MultipartFile file,
            Principal principal) {
        try (InputStream content = file.getInputStream()) {
            FileItemResponse response = FileApiMapper.toResponse(uploadHandler.upload(principal,
                    new UploadWorkspaceFileCommand(workspaceId, file.getOriginalFilename(),
                            file.getContentType(), file.getSize(), content)));
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (IOException ex) {
            throw DomainException.badRequest("Uploaded file cannot be read",
                    Map.of("field", "file"));
        }
    }

    @PatchMapping("/files/{fileId}")
    public FileItemResponse rename(@PathVariable UUID fileId,
                                   @RequestBody(required = false) FileRenameRequest request,
                                   Principal principal) {
        if (request == null || request.name() == null) {
            throw DomainException.badRequest("name is required", Map.of("field", "name"));
        }
        return FileApiMapper.toResponse(mutationService.rename(principal, fileId,
                request.name()));
    }

    @DeleteMapping("/files/{fileId}")
    public ResponseEntity<Void> delete(@PathVariable UUID fileId, Principal principal) {
        mutationService.delete(principal, fileId);
        return ResponseEntity.noContent().build();
    }
}
