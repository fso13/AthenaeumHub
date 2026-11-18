package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

/**
 * OpenAPI {@code EnvelopeCoverage} (§4.2). {@code devices}/{@code covered} are the
 * deprecated aggregates; {@code peer_*} and {@code self_*} are the honest counters and
 * only ACTIVE {@code e2ee_capable} devices are counted anywhere.
 */
public record EnvelopeCoverageResponse(
        int devices,
        int covered,
        int peerDevices,
        int peerCovered,
        int selfDevices,
        int selfCovered,
        List<UUID> uncoveredDeviceIds,
        String warning) {
}
