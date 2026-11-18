package ru.krug.backend.message.application.service;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.message.application.model.E2eeSendPlan;
import ru.krug.backend.message.application.model.EnvelopeCoverageView;
import ru.krug.backend.message.application.model.MessageDeviceView;
import ru.krug.backend.message.application.port.MessageChatContextPort.ChatContext;
import ru.krug.backend.message.application.port.MessageDeviceDirectoryPort;
import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.EnvelopePrekey;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Device-aware E2EE envelope validation and coverage (E2EE-SPEC §4.2/§4.7/§5.2). The
 * server checks only public facts: membership, ACTIVE + {@code e2ee_capable} targets,
 * current key generations, the binding of the sender identity keys in the {@code prekey}
 * block and the per-envelope ciphertext shape. It never decrypts, never verifies a private
 * secret and never performs a partial fan-out: any failure rejects the whole message before
 * {@code seq} allocation.
 */
@Service
public class E2eeEnvelopeValidator {

    private final MessageDeviceDirectoryPort devices;

    public E2eeEnvelopeValidator(MessageDeviceDirectoryPort devices) {
        this.devices = devices;
    }

    public E2eeSendPlan validate(Principal principal, UUID chatId, ChatContext chat,
                                 List<CryptoEnvelope> envelopes) {
        if (!"DIRECT".equals(chat.type())) {
            throw DomainException.conflict(ErrorCode.E2EE_GROUP_NOT_SUPPORTED,
                    "E2EE GROUP chats are not supported in E7", Map.of("type", chat.type()));
        }
        MessageDeviceView sender = devices.findDevice(principal.deviceId())
                .orElseThrow(() -> DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                        "Sender device is not an active device of the caller",
                        Map.of("field", "X-Device-Id")));
        if (!sender.active()) {
            throw DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                    "Sender device is not active", Map.of("field", "sender_device_id"));
        }
        if (!sender.userId().equals(principal.userId())) {
            throw DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                    "Sender device does not belong to the caller",
                    Map.of("field", "X-Device-Id"));
        }
        if (!sender.e2eeCapable()) {
            throw DomainException.unprocessable(ErrorCode.E2EE_LEGACY_DEVICE,
                    "A legacy device cannot send E2EE messages",
                    Map.of("field", "sender_device_id"));
        }
        UUID peerUserId = chat.peerUserId();
        if (peerUserId == null) {
            throw DomainException.conflict(ErrorCode.E2EE_NO_ACTIVE_DEVICES,
                    "The peer has no active E2EE-capable device",
                    Map.of("required", "e2ee_capable_device"));
        }

        List<MessageDeviceView> candidates = devices.activeE2eeDevices(
                        List.of(principal.userId(), peerUserId)).stream()
                .filter(MessageDeviceView::active)
                .filter(MessageDeviceView::e2eeCapable)
                .toList();
        Map<UUID, MessageDeviceView> byDeviceId = new HashMap<>();
        for (MessageDeviceView candidate : candidates) {
            byDeviceId.put(candidate.deviceId(), candidate);
        }
        List<MessageDeviceView> peerDevices = candidates.stream()
                .filter(device -> device.userId().equals(peerUserId)).toList();
        List<MessageDeviceView> selfDevices = candidates.stream()
                .filter(device -> device.userId().equals(principal.userId()))
                .filter(device -> !device.deviceId().equals(sender.deviceId()))
                .toList();
        if (peerDevices.isEmpty()) {
            // P1-7: reject before creating a Message, never report a fake covered==devices.
            throw DomainException.conflict(ErrorCode.E2EE_NO_ACTIVE_DEVICES,
                    "The peer has no active E2EE-capable device",
                    Map.of("required", "e2ee_capable_device"));
        }

        Set<UUID> recipients = new HashSet<>();
        for (int index = 0; index < envelopes.size(); index++) {
            CryptoEnvelope envelope = envelopes.get(index);
            String path = "envelopes[" + index + "]";
            if (!envelope.chatId().equals(chatId)) {
                throw invalid(path + ".chat_id", "chat_mismatch");
            }
            if (!envelope.senderDeviceId().equals(principal.deviceId())) {
                throw invalid(path + ".sender_device_id", "sender_device_mismatch");
            }
            requireGeneration(envelope.senderKeyGeneration(), sender.keyGeneration(),
                    path + ".sender_key_generation");
            if (envelope.prekey() != null) {
                requirePrekeyBinding(sender, envelope.prekey(), path);
            }
            if (!recipients.add(envelope.recipientDeviceId())) {
                throw DomainException.unprocessable(ErrorCode.DUPLICATE_ENVELOPE,
                        "Two envelopes address the same recipient device",
                        Map.of("field", path + ".recipient_device_id"));
            }
            if (envelope.recipientDeviceId().equals(sender.deviceId())) {
                throw invalid(path + ".recipient_device_id", "self_envelope");
            }
            MessageDeviceView recipient = byDeviceId.get(envelope.recipientDeviceId());
            if (recipient == null) {
                recipient = requireAddressableRecipient(envelope.recipientDeviceId(),
                        peerUserId, principal.userId(), path);
            }
            requireGeneration(envelope.recipientKeyGeneration(), recipient.keyGeneration(),
                    path + ".recipient_key_generation");
        }

        int peerCovered = 0;
        int selfCovered = 0;
        List<UUID> uncovered = new ArrayList<>();
        for (MessageDeviceView candidate : peerDevices) {
            if (recipients.contains(candidate.deviceId())) {
                peerCovered++;
            } else {
                uncovered.add(candidate.deviceId());
            }
        }
        int peerDeviceCount = peerDevices.size();
        for (MessageDeviceView candidate : selfDevices) {
            if (recipients.contains(candidate.deviceId())) {
                selfCovered++;
            } else {
                uncovered.add(candidate.deviceId());
            }
        }
        if (peerCovered == 0) {
            // P1-B: a 201 without delivery to the peer is forbidden; no partial fan-out.
            throw DomainException.conflict(ErrorCode.E2EE_NO_PEER_ENVELOPE,
                    "No envelope is addressed to an E2EE-capable device of the peer",
                    Map.of("field", "envelopes"));
        }
        String warning = peerCovered < peerDeviceCount
                ? EnvelopeCoverageView.PEER_DEVICE_UNCOVERED
                : selfCovered < selfDevices.size()
                        ? EnvelopeCoverageView.SELF_DEVICE_UNCOVERED : null;
        EnvelopeCoverageView coverage = new EnvelopeCoverageView(
                peerDeviceCount + selfDevices.size(), peerCovered + selfCovered,
                peerDeviceCount, peerCovered, selfDevices.size(), selfCovered,
                uncovered, warning);

        Map<UUID, Object> cryptoByDevice = new LinkedHashMap<>();
        for (CryptoEnvelope envelope : envelopes) {
            cryptoByDevice.put(envelope.recipientDeviceId(),
                    EnvelopeWireMapper.toWire(envelope));
        }
        return new E2eeSendPlan(envelopes, coverage, cryptoByDevice);
    }

    private MessageDeviceView requireAddressableRecipient(UUID recipientDeviceId,
                                                          UUID peerUserId, UUID senderUserId,
                                                          String path) {
        Optional<MessageDeviceView> found = devices.findDevice(recipientDeviceId);
        if (found.isEmpty() || !found.get().active()) {
            throw DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                    "Recipient device is unknown or revoked",
                    Map.of("field", path + ".recipient_device_id"));
        }
        MessageDeviceView device = found.get();
        if (!device.e2eeCapable()) {
            throw DomainException.unprocessable(ErrorCode.E2EE_LEGACY_DEVICE,
                    "A legacy device cannot be covered by an E2EE envelope",
                    Map.of("field", path + ".recipient_device_id"));
        }
        if (!device.userId().equals(peerUserId) && !device.userId().equals(senderUserId)) {
            throw DomainException.unprocessable(ErrorCode.UNKNOWN_DEVICE,
                    "Recipient device does not belong to a chat participant",
                    Map.of("field", path + ".recipient_device_id"));
        }
        return device;
    }

    private static void requireGeneration(int claimed, int current, String field) {
        if (claimed != current) {
            throw DomainException.conflict(ErrorCode.KEY_CHANGED,
                    "Envelope key generation does not match the current device generation",
                    Map.of("field", field, "expected", current, "actual", claimed));
        }
    }

    private static void requirePrekeyBinding(MessageDeviceView sender, EnvelopePrekey prekey,
                                             String path) {
        if (!Arrays.equals(prekey.senderIdentitySigningKey(),
                sender.identitySigningKey())) {
            throw invalid(path + ".prekey.sender_identity_signing_key", "identity_mismatch");
        }
        if (!Arrays.equals(prekey.senderIdentityDhKey(), sender.identityDhKey())) {
            throw invalid(path + ".prekey.sender_identity_dh_key", "identity_mismatch");
        }
    }

    private static DomainException invalid(String field, String reason) {
        return DomainException.unprocessable(ErrorCode.INVALID_ENVELOPE_FORMAT,
                "Invalid envelope format", Map.of("field", field, "reason", reason));
    }

    /**
     * Best-effort coverage of an already stored E2EE message, used only for an idempotent
     * replay response (D-S4-04 requires {@code envelope_coverage} on every E2EE POST).
     * It never re-validates or re-stores anything.
     */
    public EnvelopeCoverageView replayCoverage(Principal principal, UUID chatId,
                                               ChatContext chat,
                                               List<CryptoEnvelope> envelopes) {
        UUID peerUserId = chat.peerUserId();
        List<MessageDeviceView> candidates = peerUserId == null ? List.of()
                : devices.activeE2eeDevices(List.of(principal.userId(), peerUserId)).stream()
                        .filter(MessageDeviceView::active)
                        .filter(MessageDeviceView::e2eeCapable)
                        .toList();
        List<MessageDeviceView> peerDevices = candidates.stream()
                .filter(device -> device.userId().equals(peerUserId)).toList();
        List<MessageDeviceView> selfDevices = candidates.stream()
                .filter(device -> device.userId().equals(principal.userId()))
                .filter(device -> !device.deviceId().equals(principal.deviceId()))
                .toList();
        Set<UUID> recipients = new HashSet<>();
        for (CryptoEnvelope envelope : envelopes) {
            recipients.add(envelope.recipientDeviceId());
        }
        int peerCovered = 0;
        int selfCovered = 0;
        List<UUID> uncovered = new ArrayList<>();
        for (MessageDeviceView device : peerDevices) {
            if (recipients.contains(device.deviceId())) {
                peerCovered++;
            } else {
                uncovered.add(device.deviceId());
            }
        }
        for (MessageDeviceView device : selfDevices) {
            if (recipients.contains(device.deviceId())) {
                selfCovered++;
            } else {
                uncovered.add(device.deviceId());
            }
        }
        String warning = peerCovered < peerDevices.size()
                ? EnvelopeCoverageView.PEER_DEVICE_UNCOVERED
                : selfCovered < selfDevices.size()
                        ? EnvelopeCoverageView.SELF_DEVICE_UNCOVERED : null;
        return new EnvelopeCoverageView(peerDevices.size() + selfDevices.size(),
                peerCovered + selfCovered, peerDevices.size(), peerCovered, selfDevices.size(),
                selfCovered, uncovered, warning);
    }

}
