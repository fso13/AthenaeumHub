package ru.krug.backend.notification.api.dto;

import java.util.List;
import java.util.UUID;

public record ReadNotificationsRequest(List<UUID> ids, Boolean all) {
}
