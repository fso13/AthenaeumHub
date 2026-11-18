package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.KeyVerification;

public interface KeyVerificationRepository {

    void upsert(KeyVerification verification);

    List<KeyVerification> findByVerifierAndChat(UUID verifierDeviceId, UUID chatId);

    /** Replay lookup for the verification {@code Idempotency-Key} (P2-05). */
    java.util.Optional<KeyVerification> findById(UUID verificationId);

    /** Verifications created by the caller's OTHER devices for targets in this chat. */
    int countByOtherVerifierDevices(UUID workspaceId, UUID chatId, UUID verifierUserId,
                                    UUID verifierDeviceId);

    /** Revoke all attestations that target a device (key change/revoke semantics). */
    void revokeForTargetDevice(UUID targetDeviceId, Instant at);
}
