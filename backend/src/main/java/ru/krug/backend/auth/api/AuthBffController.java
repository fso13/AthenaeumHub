package ru.krug.backend.auth.api;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.AuthLoginRequest;
import ru.krug.backend.auth.api.dto.AuthLogoutRequest;
import ru.krug.backend.auth.api.dto.AuthRefreshRequest;
import ru.krug.backend.auth.api.dto.AuthRegisterRequest;
import ru.krug.backend.auth.api.dto.AuthRegisterResponse;
import ru.krug.backend.auth.api.dto.AuthResendEmailCodeRequest;
import ru.krug.backend.auth.api.dto.AuthResendEmailCodeResponse;
import ru.krug.backend.auth.api.dto.AuthSessionResponse;
import ru.krug.backend.auth.api.dto.AuthVerifyEmailRequest;
import ru.krug.backend.auth.api.mapper.AuthBffApiMapper;
import ru.krug.backend.auth.application.command.LoginCommand;
import ru.krug.backend.auth.application.command.RegisterCommand;
import ru.krug.backend.auth.application.command.VerifyEmailCommand;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.usecase.LoginService;
import ru.krug.backend.auth.application.usecase.LogoutService;
import ru.krug.backend.auth.application.usecase.RefreshSessionService;
import ru.krug.backend.auth.application.usecase.RegisterUserService;
import ru.krug.backend.auth.application.usecase.ResendEmailCodeService;
import ru.krug.backend.auth.application.usecase.VerifyEmailService;
import ru.krug.backend.shared.api.RequestIdFilter;

/**
 * Auth BFF: the only browser-facing auth surface. Keycloak is called server-to-server with
 * the internal URL; passwords, codes and tokens are never logged.
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthBffController {

    private final RegisterUserService registerUserService;
    private final VerifyEmailService verifyEmailService;
    private final ResendEmailCodeService resendEmailCodeService;
    private final LoginService loginService;
    private final RefreshSessionService refreshSessionService;
    private final LogoutService logoutService;
    private final AuthBffSettings settings;

    public AuthBffController(RegisterUserService registerUserService,
                             VerifyEmailService verifyEmailService,
                             ResendEmailCodeService resendEmailCodeService,
                             LoginService loginService,
                             RefreshSessionService refreshSessionService,
                             LogoutService logoutService,
                             AuthBffSettings settings) {
        this.registerUserService = registerUserService;
        this.verifyEmailService = verifyEmailService;
        this.resendEmailCodeService = resendEmailCodeService;
        this.loginService = loginService;
        this.refreshSessionService = refreshSessionService;
        this.logoutService = logoutService;
        this.settings = settings;
    }

    @PostMapping("/register")
    public ResponseEntity<AuthRegisterResponse> register(
            @Valid @RequestBody AuthRegisterRequest request, HttpServletRequest http) {
        var view = registerUserService.register(new RegisterCommand(request.email(),
                request.displayName(), request.password()), clientIp(http));
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(AuthBffApiMapper.toResponse(view));
    }

    @PostMapping("/verify-email")
    public AuthSessionResponse verifyEmail(@Valid @RequestBody AuthVerifyEmailRequest request,
                                           HttpServletRequest http) {
        return AuthBffApiMapper.toResponse(verifyEmailService.verify(
                new VerifyEmailCommand(request.verificationId(), request.code()),
                RequestIdFilter.requestId(http)));
    }

    @PostMapping("/resend-email-code")
    public ResponseEntity<AuthResendEmailCodeResponse> resendEmailCode(
            @Valid @RequestBody AuthResendEmailCodeRequest request, HttpServletRequest http) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(AuthBffApiMapper.toResponse(resendEmailCodeService.resend(
                        request.verificationId(), clientIp(http))));
    }

    @PostMapping("/login")
    public AuthSessionResponse login(@Valid @RequestBody AuthLoginRequest request,
                                     HttpServletRequest http) {
        return AuthBffApiMapper.toResponse(loginService.login(
                new LoginCommand(request.email(), request.password()), clientIp(http),
                RequestIdFilter.requestId(http)));
    }

    @PostMapping("/refresh")
    public AuthSessionResponse refresh(@Valid @RequestBody AuthRefreshRequest request,
                                       HttpServletRequest http) {
        return AuthBffApiMapper.toResponse(refreshSessionService.refresh(
                request.refreshToken(), RequestIdFilter.requestId(http)));
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(@Valid @RequestBody AuthLogoutRequest request) {
        logoutService.logout(request.refreshToken());
        return ResponseEntity.noContent().build();
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
