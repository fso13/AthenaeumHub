package ru.krug.backend.notification.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.notification.api.dto.NotificationPageResponse;
import ru.krug.backend.notification.api.dto.NotificationPreferencePatchRequest;
import ru.krug.backend.notification.api.dto.NotificationPreferenceResponse;
import ru.krug.backend.notification.api.dto.NotificationPreferencesResponse;
import ru.krug.backend.notification.api.dto.ReadNotificationsRequest;
import ru.krug.backend.notification.api.mapper.NotificationApiMapper;
import ru.krug.backend.notification.application.usecase.GetPreferencesUseCase;
import ru.krug.backend.notification.application.usecase.ListNotificationsUseCase;
import ru.krug.backend.notification.application.usecase.MarkReadUseCase;
import ru.krug.backend.notification.application.usecase.UpdatePreferenceUseCase;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;

/**
 * E6-B notification endpoints. X-Device-Id is enforced by DeviceBindingFilter; every row
 * is scoped to the authenticated user. Mutations follow the contract's Idempotency-Key
 * requirement and are naturally idempotent (read_at is set once; preference PATCH upserts).
 */
@RestController
@RequestMapping("/api/v1")
public class NotificationController {

    private final ListNotificationsUseCase listNotifications;
    private final MarkReadUseCase markRead;
    private final GetPreferencesUseCase getPreferences;
    private final UpdatePreferenceUseCase updatePreference;

    public NotificationController(ListNotificationsUseCase listNotifications,
                                  MarkReadUseCase markRead,
                                  GetPreferencesUseCase getPreferences,
                                  UpdatePreferenceUseCase updatePreference) {
        this.listNotifications = listNotifications;
        this.markRead = markRead;
        this.getPreferences = getPreferences;
        this.updatePreference = updatePreference;
    }

    @GetMapping("/notifications")
    public NotificationPageResponse list(
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return NotificationApiMapper.toPage(listNotifications.list(principal, cursor, limit));
    }

    @PostMapping("/notifications/read")
    public ResponseEntity<Void> markRead(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody ReadNotificationsRequest request,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        markRead.markRead(principal, request.ids(), Boolean.TRUE.equals(request.all()));
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/notification-preferences")
    public NotificationPreferencesResponse preferences(Principal principal) {
        return NotificationApiMapper.toPreferences(getPreferences.get(principal));
    }

    @PatchMapping("/notification-preferences")
    public NotificationPreferenceResponse updatePreference(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody NotificationPreferencePatchRequest request,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        return NotificationApiMapper.toResponse(updatePreference.update(principal, request.chatId(),
                request.type(), request.channel(), request.mode()));
    }
}
