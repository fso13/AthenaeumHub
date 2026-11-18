package ru.krug.backend.auth.api;

import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.DeviceListResponse;
import ru.krug.backend.auth.api.dto.DeviceRegistrationRequest;
import ru.krug.backend.auth.api.dto.DeviceResponse;
import ru.krug.backend.auth.api.dto.PrekeyUploadResultResponse;
import ru.krug.backend.auth.api.dto.SignedPrekeyUploadRequest;
import ru.krug.backend.auth.api.mapper.AuthApiMapper;
import ru.krug.backend.auth.api.mapper.DeviceRequestMapper;
import ru.krug.backend.auth.application.command.RegisterDeviceCommand;
import ru.krug.backend.auth.application.command.SignedPrekeyCommand;
import ru.krug.backend.auth.application.model.DeviceRegistrationResult;
import ru.krug.backend.auth.application.model.PrekeyUploadView;
import ru.krug.backend.auth.application.usecase.DeviceQueryService;
import ru.krug.backend.auth.application.usecase.DeviceRevocationService;
import ru.krug.backend.auth.application.usecase.PrekeyUploadService;
import ru.krug.backend.auth.application.usecase.RegisterDeviceUseCase;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

@RestController
@RequestMapping("/api/v1")
public class DeviceController {

    private final RegisterDeviceUseCase registerDeviceUseCase;
    private final DeviceQueryService deviceQueryService;
    private final DeviceRevocationService revocationService;
    private final PrekeyUploadService prekeyUploadService;

    public DeviceController(RegisterDeviceUseCase registerDeviceUseCase,
                            DeviceQueryService deviceQueryService,
                            DeviceRevocationService revocationService,
                            PrekeyUploadService prekeyUploadService) {
        this.registerDeviceUseCase = registerDeviceUseCase;
        this.deviceQueryService = deviceQueryService;
        this.revocationService = revocationService;
        this.prekeyUploadService = prekeyUploadService;
    }

    @PostMapping("/devices")
    public ResponseEntity<DeviceResponse> register(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody DeviceRegistrationRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        RegisterDeviceCommand command = DeviceRequestMapper.toCommand(request);
        DeviceRegistrationResult result = registerDeviceUseCase.register(principal, key, command);
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(result.status());
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(AuthApiMapper.toResponse(result.device()));
    }

    @GetMapping("/devices")
    public DeviceListResponse list(Principal principal) {
        return AuthApiMapper.toListResponse(deviceQueryService.listDevices(principal));
    }

    @DeleteMapping("/devices/{deviceId}")
    public ResponseEntity<Void> revoke(
            @PathVariable UUID deviceId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        revocationService.revoke(principal, deviceId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/devices/{deviceId}/prekeys")
    public PrekeyUploadResultResponse uploadPrekeys(
            @PathVariable UUID deviceId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) SignedPrekeyUploadRequest request,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        SignedPrekeyCommand spk = DeviceRequestMapper.toCommand(request.signedPrekey());
        PrekeyUploadView view = prekeyUploadService.upload(principal, deviceId, spk,
                DeviceRequestMapper.toOneTime(request.oneTimePrekeys()));
        return AuthApiMapper.toResponse(view);
    }
}
