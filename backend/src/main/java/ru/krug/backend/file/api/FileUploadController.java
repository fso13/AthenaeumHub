package ru.krug.backend.file.api;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.file.api.dto.PreflightFileRequest;
import ru.krug.backend.file.api.dto.PreflightRequest;
import ru.krug.backend.file.api.dto.PreflightResponse;
import ru.krug.backend.file.api.dto.UploadCompleteRequest;
import ru.krug.backend.file.api.dto.UploadInitRequest;
import ru.krug.backend.file.api.dto.UploadPartResponse;
import ru.krug.backend.file.api.dto.UploadSessionResponse;
import ru.krug.backend.file.api.mapper.FileApiMapper;
import ru.krug.backend.file.application.command.AbortUploadCommand;
import ru.krug.backend.file.application.command.CompleteUploadCommand;
import ru.krug.backend.file.application.command.InitUploadCommand;
import ru.krug.backend.file.application.command.PreflightCommand;
import ru.krug.backend.file.application.command.PutPartCommand;
import ru.krug.backend.file.application.model.FileCandidate;
import ru.krug.backend.file.application.usecase.AbortUploadHandler;
import ru.krug.backend.file.application.usecase.CompleteUploadHandler;
import ru.krug.backend.file.application.usecase.InitUploadHandler;
import ru.krug.backend.file.application.usecase.PreflightService;
import ru.krug.backend.file.application.usecase.UploadPartHandler;
import ru.krug.backend.file.application.usecase.UploadQueryHandler;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * Managed upload API: preflight -> init -> parts -> complete/abort, exactly as
 * contracts/openapi.yaml. Idempotency-Key is required on every mutating call.
 */
@RestController
@RequestMapping("/api/v1/uploads")
public class FileUploadController {

    private final PreflightService preflightService;
    private final InitUploadHandler initUploadHandler;
    private final UploadPartHandler uploadPartHandler;
    private final UploadQueryHandler uploadQueryHandler;
    private final CompleteUploadHandler completeUploadHandler;
    private final AbortUploadHandler abortUploadHandler;

    public FileUploadController(PreflightService preflightService,
                                InitUploadHandler initUploadHandler,
                                UploadPartHandler uploadPartHandler,
                                UploadQueryHandler uploadQueryHandler,
                                CompleteUploadHandler completeUploadHandler,
                                AbortUploadHandler abortUploadHandler) {
        this.preflightService = preflightService;
        this.initUploadHandler = initUploadHandler;
        this.uploadPartHandler = uploadPartHandler;
        this.uploadQueryHandler = uploadQueryHandler;
        this.completeUploadHandler = completeUploadHandler;
        this.abortUploadHandler = abortUploadHandler;
    }

    @PostMapping("/preflight")
    public PreflightResponse preflight(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody PreflightRequest request,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null || request.chatId() == null) {
            throw DomainException.badRequest("chat_id is required", Map.of("field", "chat_id"));
        }
        List<FileCandidate> files = request.files() == null ? List.of()
                : request.files().stream().map(FileUploadController::candidate).toList();
        return FileApiMapper.toResponse(preflightService.preflight(
                new PreflightCommand(principal, request.chatId(), files)));
    }

    @PostMapping
    public ResponseEntity<UploadSessionResponse> init(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody UploadInitRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null || request.chatId() == null) {
            throw DomainException.badRequest("chat_id is required", Map.of("field", "chat_id"));
        }
        if (request.encryptionMode() == null || request.encryptionMode().isBlank()) {
            throw DomainException.badRequest("encryption_mode is required",
                    Map.of("field", "encryption_mode"));
        }
        UploadSessionResponse response = FileApiMapper.toResponse(initUploadHandler.init(
                new InitUploadCommand(principal, key, request.chatId(), request.filename(),
                        request.sizeOrZero(), request.mime(), request.sha256(),
                        request.encryptionMode())));
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping("/{uploadId}")
    public UploadSessionResponse get(@PathVariable UUID uploadId, Principal principal) {
        return FileApiMapper.toResponse(uploadQueryHandler.get(principal, uploadId));
    }

    @PutMapping(value = "/{uploadId}/parts/{partNo}",
            consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public UploadPartResponse putPart(
            @PathVariable UUID uploadId,
            @PathVariable int partNo,
            @RequestHeader("Content-SHA256") String contentSha256,
            @RequestBody byte[] content,
            Principal principal) {
        return FileApiMapper.toResponse(uploadPartHandler.put(new PutPartCommand(principal,
                uploadId, partNo, contentSha256, content)));
    }

    @PostMapping("/{uploadId}/complete")
    public ResponseEntity<UploadSessionResponse> complete(
            @PathVariable UUID uploadId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody UploadCompleteRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null || request.sha256() == null || request.partsCount() == null
                || request.partsCount() < 1) {
            throw DomainException.badRequest("sha256 and parts_count are required",
                    Map.of("field", "sha256|parts_count"));
        }
        UploadSessionResponse response = FileApiMapper.toResponse(completeUploadHandler.complete(
                new CompleteUploadCommand(principal, uploadId, key, request.sha256(),
                        request.partsCount())));
        HttpStatus status = "SCANNING".equals(response.status()) ? HttpStatus.ACCEPTED
                : HttpStatus.OK;
        return ResponseEntity.status(status).body(response);
    }

    @PostMapping("/{uploadId}/abort")
    public ResponseEntity<Void> abort(
            @PathVariable UUID uploadId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        abortUploadHandler.abort(new AbortUploadCommand(principal, uploadId, key));
        return ResponseEntity.noContent().build();
    }

    private static FileCandidate candidate(PreflightFileRequest file) {
        return new FileCandidate(file.name(), file.sizeOrZero(), file.mime(), file.sha256());
    }
}
