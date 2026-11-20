package ru.krug.backend.chat.domain.service;

import java.util.Map;

import ru.krug.backend.chat.domain.model.ChannelJoinPolicy;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * P0-2 coherence rules between a channel's visibility and its join policy.
 *
 * <p>A PUBLIC channel is workspace-wide by definition: every ACTIVE workspace member is a
 * participant and future members are added automatically. Allowing {@code INVITE_ONLY} or
 * {@code CLOSED} together with PUBLIC would create a channel that nobody can discover but
 * that is still described as public, so the combination is rejected with a semantic 422.
 * PRIVATE channels accept any join policy.</p>
 */
public final class ChannelSettingsPolicy {

    private ChannelSettingsPolicy() {
    }

    public static ChannelVisibility parseVisibility(String value) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest("visibility is required",
                    Map.of("field", "visibility"));
        }
        try {
            return ChannelVisibility.valueOf(value);
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("visibility is invalid",
                    Map.of("field", "visibility", "allowed", "PUBLIC,PRIVATE"));
        }
    }

    public static ChannelJoinPolicy parseJoinPolicy(String value) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest("join_policy is required",
                    Map.of("field", "join_policy"));
        }
        try {
            return ChannelJoinPolicy.valueOf(value);
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("join_policy is invalid",
                    Map.of("field", "join_policy",
                            "allowed", "OPEN,INVITE_ONLY,CLOSED"));
        }
    }

    /**
     * @throws DomainException 422 when PUBLIC would be combined with a non-OPEN policy
     */
    public static void requireCoherent(ChannelVisibility visibility, ChannelJoinPolicy policy) {
        if (visibility == ChannelVisibility.PUBLIC
                && policy != ChannelJoinPolicy.OPEN) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "A PUBLIC channel requires join_policy=OPEN",
                    Map.of("field", "join_policy", "visibility", visibility.name(),
                            "required", "OPEN"));
        }
    }
}
