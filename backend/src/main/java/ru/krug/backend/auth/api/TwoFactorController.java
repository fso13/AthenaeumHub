package ru.krug.backend.auth.api;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.TwoFactorDisableRequest;
import ru.krug.backend.auth.api.dto.TwoFactorRecoveryCodesRequest;
import ru.krug.backend.auth.api.dto.TwoFactorRecoveryCodesResponse;
import ru.krug.backend.auth.api.dto.TwoFactorSetupRequest;
import ru.krug.backend.auth.api.dto.TwoFactorSetupResponse;
import ru.krug.backend.auth.api.dto.TwoFactorStatusResponse;
import ru.krug.backend.auth.api.dto.TwoFactorVerifyRequest;
import ru.krug.backend.auth.application.model.TwoFactorRecoveryCodesView;
import ru.krug.backend.auth.application.model.TwoFactorSetupView;
import ru.krug.backend.auth.application.model.TwoFactorStatusView;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.usecase.TwoFactorService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * TOTP authenticator self-service (P0-4 / #82).
 *
 * <pre>
 * GET    /me/2fa                 — status (no secret)
 * POST   /me/2fa/setup           — start setup; secret/otpauth URI returned once
 * POST   /me/2fa/verify          — confirm the pending secret with a code
 * DELETE /me/2fa                 — disable; password + TOTP/recovery code required
 * POST   /me/2fa/recovery-codes  — regenerate the one-time list (password required)
 * </pre>
 */
@RestController
@RequestMapping("/api/v1/me/2fa")
public class TwoFactorController {

    private final TwoFactorService twoFactor;
    private final AuthBffSettings settings;

    public TwoFactorController(TwoFactorService twoFactor, AuthBffSettings settings) {
        this.twoFactor = twoFactor;
        this.settings = settings;
    }

    @GetMapping
    public TwoFactorStatusResponse status(Principal principal) {
        return toResponse(twoFactor.status(principal));
    }

    @PostMapping("/setup")
    public TwoFactorSetupResponse setup(@Valid @RequestBody TwoFactorSetupRequest request,
                                        Principal principal, HttpServletRequest http) {
        TwoFactorSetupView view = twoFactor.setup(principal, request.password(), clientIp(http));
        return new TwoFactorSetupResponse(view.secret(), view.otpauthUri(), view.qrPayload());
    }

    @PostMapping("/verify")
    public TwoFactorStatusResponse verify(@Valid @RequestBody TwoFactorVerifyRequest request,
                                          Principal principal, HttpServletRequest http) {
        return toResponse(twoFactor.verify(principal, request.code(), clientIp(http)));
    }

    @DeleteMapping
    public ResponseEntity<Void> disable(@Valid @RequestBody TwoFactorDisableRequest request,
                                        Principal principal, HttpServletRequest http) {
        twoFactor.disable(principal, request.password(), request.code(), clientIp(http));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/recovery-codes")
    public TwoFactorRecoveryCodesResponse recoveryCodes(
            @Valid @RequestBody TwoFactorRecoveryCodesRequest request,
            Principal principal, HttpServletRequest http) {
        TwoFactorRecoveryCodesView view = twoFactor.regenerateRecoveryCodes(principal,
                request.password(), clientIp(http));
        return new TwoFactorRecoveryCodesResponse(view.codes(), view.remaining());
    }

    private static TwoFactorStatusResponse toResponse(TwoFactorStatusView view) {
        return new TwoFactorStatusResponse(view.enabled(), view.enabledAt(),
                view.recoveryCodesRemaining());
    }

    private String clientIp(HttpServletRequest request) {
        if (settings.trustForwardedFor()) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (forwarded != null && !forwarded.isBlank()) {
                String first = forwarded.split(",", 2)[0].strip();
                if (first.length() <= 64 && first.matches("[0-9a-fA-F:.\\[\\]]+")) {
                    return first;
                }
            }
        }
        String remote = request.getRemoteAddr();
        return remote == null || remote.isBlank() ? "unknown" : remote;
    }
}
