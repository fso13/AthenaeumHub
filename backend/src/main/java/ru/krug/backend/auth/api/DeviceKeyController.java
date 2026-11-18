package ru.krug.backend.auth.api;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.ChatKeysResponse;
import ru.krug.backend.auth.api.dto.KeyClaimRequest;
import ru.krug.backend.auth.api.dto.KeyClaimResponse;
import ru.krug.backend.auth.api.dto.VerificationRequest;
import ru.krug.backend.auth.api.dto.VerificationResponse;
import ru.krug.backend.auth.api.mapper.AuthApiMapper;
import ru.krug.backend.auth.application.model.KeyClaimView;
import ru.krug.backend.auth.application.usecase.ChatKeysService;
import ru.krug.backend.auth.application.usecase.KeyClaimService;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * Device-key protocol endpoints: claim, chat keys and verification (§6.2.5–7).
 * E2EE message send/fan-out is deliberately absent (E7-B3/B4).
 */
@RestController
@RequestMapping("/api/v1")
public class DeviceKeyController {

    private final KeyClaimService keyClaimService;
    private final ChatKeysService chatKeysService;

    public DeviceKeyController(KeyClaimService keyClaimService, ChatKeysService chatKeysService) {
        this.keyClaimService = keyClaimService;
        this.chatKeysService = chatKeysService;
    }

    @PostMapping("/keys/claim")
    public KeyClaimResponse claim(@RequestBody(required = false) KeyClaimRequest request,
                                  Principal principal) {
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    Map.of("reason", "missing_body"));
        }
        List<KeyClaimService.DeviceRef> devices = request.devices() == null ? List.of()
                : request.devices().stream()
                        .map(item -> new KeyClaimService.DeviceRef(item.deviceId(),
                                item.userId()))
                        .toList();
        KeyClaimView view = keyClaimService.claim(principal, request.chatId(), devices);
        return AuthApiMapper.toResponse(view);
    }

    @GetMapping("/chats/{chatId}/keys")
    public ChatKeysResponse chatKeys(@PathVariable UUID chatId, Principal principal) {
        return AuthApiMapper.toResponse(chatKeysService.getChatKeys(principal, chatId));
    }

    @PutMapping("/chats/{chatId}/keys/verification")
    public ResponseEntity<VerificationResponse> verify(
            @PathVariable UUID chatId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody VerificationRequest request,
            Principal principal) {
        UUID key = RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        var view = chatKeysService.verifyDevice(principal, chatId, key,
                new ChatKeysService.VerificationCommand(request.deviceId(), request.method(),
                        request.vhVersion(), request.safetyNumberHash(),
                        request.expectedKeyGeneration()));
        return ResponseEntity.status(201).body(AuthApiMapper.toResponse(view));
    }
}
