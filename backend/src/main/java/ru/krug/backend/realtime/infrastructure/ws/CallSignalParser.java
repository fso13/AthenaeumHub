package ru.krug.backend.realtime.infrastructure.ws;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import ru.krug.backend.realtime.application.model.CallKind;
import ru.krug.backend.realtime.application.model.CallSignal;
import ru.krug.backend.realtime.domain.exception.CallSignalRejectedException;

/**
 * Structural validation for the client {@code call.signal} payload. Validation happens
 * before any database access; messages are generic and never echo SDP/candidate content.
 */
@Component
public class CallSignalParser {

    private static final TypeReference<Map<String, Object>> CANDIDATE_TYPE =
            new TypeReference<>() { };

    private final ObjectMapper mapper;

    public CallSignalParser(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public CallSignal parse(JsonNode payload, int maxSdpBytes, int maxCandidateBytes) {
        if (payload == null || !payload.isObject()) {
            throw CallSignalRejectedException.malformed("payload must be an object");
        }
        UUID callId = parseUuid(payload.path("call_id").asText(null));
        if (callId == null) {
            throw CallSignalRejectedException.malformed("payload.call_id must be a UUID");
        }
        CallKind kind = CallKind.fromWire(payload.path("kind").asText(null));
        if (kind == null) {
            throw CallSignalRejectedException.malformed(
                    "payload.kind must be one of offer|answer|ice|hangup|busy");
        }
        JsonNode videoNode = payload.get("video");
        if (videoNode == null || !videoNode.isBoolean()) {
            throw CallSignalRejectedException.malformed("payload.video must be a boolean");
        }
        boolean video = videoNode.booleanValue();

        String sdp = text(payload.get("sdp"), "payload.sdp");
        if (sdp != null) {
            if (sdp.isBlank()) {
                throw CallSignalRejectedException.malformed("payload.sdp must not be blank");
            }
            if (sdp.getBytes(StandardCharsets.UTF_8).length > maxSdpBytes) {
                throw CallSignalRejectedException.payloadTooLarge(
                        "payload.sdp exceeds " + maxSdpBytes + " bytes");
            }
        }
        Map<String, Object> candidate = candidate(payload.get("candidate"), maxCandidateBytes);

        switch (kind) {
            case OFFER, ANSWER -> {
                if (sdp == null) {
                    throw CallSignalRejectedException.malformed(
                            "payload.sdp is required for " + kind.wire());
                }
                if (candidate != null) {
                    throw CallSignalRejectedException.malformed(
                            "payload.candidate is only valid for ice");
                }
            }
            case ICE -> {
                if (candidate == null) {
                    throw CallSignalRejectedException.malformed(
                            "payload.candidate is required for ice");
                }
                if (sdp != null) {
                    throw CallSignalRejectedException.malformed(
                            "payload.sdp is only valid for offer/answer");
                }
            }
            case HANGUP, BUSY -> {
                if (sdp != null || candidate != null) {
                    throw CallSignalRejectedException.malformed(
                            "payload.sdp/candidate are not valid for " + kind.wire());
                }
            }
            default -> throw CallSignalRejectedException.malformed("unsupported kind");
        }
        return new CallSignal(callId, kind, video, sdp, candidate);
    }

    /** Strict canonical UUID: rejects the legacy short forms accepted by UUID.fromString. */
    public static UUID parseUuid(String value) {
        if (value == null || value.length() != 36
                || value.charAt(8) != '-' || value.charAt(13) != '-'
                || value.charAt(18) != '-' || value.charAt(23) != '-') {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isTextual()) {
            throw CallSignalRejectedException.malformed(field + " must be a string");
        }
        return node.textValue();
    }

    private Map<String, Object> candidate(JsonNode node, int maxBytes) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isObject()) {
            throw CallSignalRejectedException.malformed("payload.candidate must be an object");
        }
        try {
            int size = mapper.writeValueAsBytes(node).length;
            if (size > maxBytes) {
                throw CallSignalRejectedException.payloadTooLarge(
                        "payload.candidate exceeds " + maxBytes + " bytes");
            }
            return mapper.convertValue(node, CANDIDATE_TYPE);
        } catch (CallSignalRejectedException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw CallSignalRejectedException.malformed("payload.candidate is not valid JSON");
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw CallSignalRejectedException.malformed("payload.candidate is not valid JSON");
        }
    }
}
