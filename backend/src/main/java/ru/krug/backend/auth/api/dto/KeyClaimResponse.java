package ru.krug.backend.auth.api.dto;

import java.util.List;

public record KeyClaimResponse(List<PrekeyBundleResponse> bundles,
                               List<UnavailableDeviceResponse> unavailable) {
}
