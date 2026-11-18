package ru.krug.backend.notification.api.dto;

import java.util.List;

public record NotificationPreferencesResponse(List<NotificationPreferenceResponse> items) {
}
