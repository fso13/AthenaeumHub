package ru.krug.backend.message.application.model;

import java.util.List;
import java.util.UUID;

/**
 * E2EE fan-out coverage (§4.2). Candidates and coverage count only ACTIVE
 * {@code e2ee_capable} devices; legacy devices are never candidates and never coverage.
 * {@code warning} carries at most one value; peer warning has priority.
 */
public record EnvelopeCoverageView(int devices, int covered, int peerDevices, int peerCovered,
                                    int selfDevices, int selfCovered,
                                    List<UUID> uncoveredDeviceIds, String warning) {

    public static final String PEER_DEVICE_UNCOVERED = "PEER_DEVICE_UNCOVERED";
    public static final String SELF_DEVICE_UNCOVERED = "SELF_DEVICE_UNCOVERED";

    public EnvelopeCoverageView {
        uncoveredDeviceIds = uncoveredDeviceIds == null ? List.of()
                : List.copyOf(uncoveredDeviceIds);
    }
}
