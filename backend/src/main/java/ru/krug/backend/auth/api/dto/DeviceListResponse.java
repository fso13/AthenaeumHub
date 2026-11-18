package ru.krug.backend.auth.api.dto;

import java.util.List;

public record DeviceListResponse(List<DeviceResponse> items) {
}
