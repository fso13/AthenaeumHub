package ru.krug.backend.ops.api;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminSettingsPatchRequest;
import ru.krug.backend.ops.api.dto.AdminSettingsResponse;
import ru.krug.backend.ops.api.dto.TestEmailRequest;
import ru.krug.backend.ops.api.dto.TestEmailResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.GetAdminSettingsService;
import ru.krug.backend.ops.application.usecase.SendTestEmailService;
import ru.krug.backend.ops.application.usecase.UpdateAdminSettingsService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Platform-admin settings (R-03/R-04). Controllers stay thin; the server-side admin guard
 * lives in the use cases, so a direct API call from a non-admin is always 403.
 */
@RestController
@RequestMapping("/api/v1/admin/settings")
public class AdminSettingsController {

    private final GetAdminSettingsService getSettings;
    private final UpdateAdminSettingsService updateSettings;
    private final SendTestEmailService sendTestEmail;

    public AdminSettingsController(GetAdminSettingsService getSettings,
                                   UpdateAdminSettingsService updateSettings,
                                   SendTestEmailService sendTestEmail) {
        this.getSettings = getSettings;
        this.updateSettings = updateSettings;
        this.sendTestEmail = sendTestEmail;
    }

    @GetMapping
    public AdminSettingsResponse get(Principal principal) {
        return AdminApiMapper.toResponse(getSettings.get(principal));
    }

    @PatchMapping
    public AdminSettingsResponse patch(@Valid @RequestBody AdminSettingsPatchRequest request,
                                       Principal principal) {
        return AdminApiMapper.toResponse(updateSettings.update(principal,
                AdminApiMapper.toCommand(request)));
    }

    @PostMapping("/test-email")
    public ResponseEntity<TestEmailResponse> testEmail(
            @Valid @RequestBody TestEmailRequest request, Principal principal) {
        sendTestEmail.send(principal, request.to());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(AdminApiMapper.toResponse(request.to()));
    }
}
