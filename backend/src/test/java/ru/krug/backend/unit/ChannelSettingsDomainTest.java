package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.domain.model.ChannelJoinPolicy;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.service.ChannelSettingsPolicy;
import ru.krug.backend.chat.domain.service.ChatPermissionPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * P0-2 (#80) domain rules: the built-in rights matrix, edit validation and the
 * visibility/join-policy coherence invariant. These rules are enforced identically by the
 * HTTP path, so they are pinned here without a database.
 */
class ChannelSettingsDomainTest {

    @Test
    void defaultRightsMatchTheProductMatrix() {
        assertThat(ChatPermissionPolicy.defaults(ChatMember.Role.OWNER))
                .containsExactlyInAnyOrderEntriesOf(all(true));
        assertThat(ChatPermissionPolicy.defaults(ChatMember.Role.ADMIN))
                .containsExactlyInAnyOrderEntriesOf(all(true));
        assertThat(ChatPermissionPolicy.defaults(ChatMember.Role.MODERATOR))
                .containsEntry(ChatPermission.POST_MESSAGES, true)
                .containsEntry(ChatPermission.INVITE_MEMBERS, true)
                .containsEntry(ChatPermission.CREATE_POLLS, true)
                .containsEntry(ChatPermission.START_CALLS, true)
                .containsEntry(ChatPermission.PIN_MESSAGES, true)
                .containsEntry(ChatPermission.CHANGE_INFO, false);
        assertThat(ChatPermissionPolicy.defaults(ChatMember.Role.MEMBER))
                .containsEntry(ChatPermission.POST_MESSAGES, true)
                .containsEntry(ChatPermission.INVITE_MEMBERS, false)
                .containsEntry(ChatPermission.CREATE_POLLS, true)
                .containsEntry(ChatPermission.START_CALLS, true)
                .containsEntry(ChatPermission.PIN_MESSAGES, false)
                .containsEntry(ChatPermission.CHANGE_INFO, false);
        assertThat(ChatPermissionPolicy.defaults(ChatMember.Role.GUEST))
                .containsEntry(ChatPermission.POST_MESSAGES, true)
                .containsEntry(ChatPermission.INVITE_MEMBERS, false)
                .containsEntry(ChatPermission.CREATE_POLLS, false)
                .containsEntry(ChatPermission.START_CALLS, false)
                .containsEntry(ChatPermission.PIN_MESSAGES, false)
                .containsEntry(ChatPermission.CHANGE_INFO, false);

        // Every role always exposes the complete matrix.
        for (ChatMember.Role role : ChatMember.Role.values()) {
            assertThat(ChatPermissionPolicy.defaults(role))
                    .hasSize(ChatPermission.values().length);
        }
        assertThat(ChatPermissionPolicy.readOnlyManager("OWNER")).isTrue();
        assertThat(ChatPermissionPolicy.readOnlyManager("ADMIN")).isTrue();
        assertThat(ChatPermissionPolicy.readOnlyManager("MODERATOR")).isFalse();
        assertThat(ChatPermissionPolicy.readOnlyManager("MEMBER")).isFalse();
        assertThat(ChatPermissionPolicy.readOnlyManager("GUEST")).isFalse();
    }

    @Test
    void rightsPatchParsesWireNamesAndRejectsOwnerAndUnknownEntries() {
        Map<String, Map<String, Boolean>> raw = new LinkedHashMap<>();
        raw.put("MODERATOR", Map.of("pin_messages", false, "change_info", true));
        raw.put("MEMBER", Map.of("invite_members", true));

        Map<ChatMember.Role, Map<ChatPermission, Boolean>> parsed =
                ChatPermissionPolicy.parsePatch(raw);
        assertThat(parsed.get(ChatMember.Role.MODERATOR))
                .containsEntry(ChatPermission.PIN_MESSAGES, false)
                .containsEntry(ChatPermission.CHANGE_INFO, true);
        assertThat(parsed.get(ChatMember.Role.MEMBER))
                .containsEntry(ChatPermission.INVITE_MEMBERS, true);

        assertThat(ChatPermissionPolicy.parsePatch(null)).isEmpty();
        assertThat(ChatPermissionPolicy.parsePatch(Map.of())).isEmpty();

        assertError(() -> ChatPermissionPolicy.parsePatch(Map.of("OWNER", Map.of(
                "post_messages", false))), ErrorCategory.UNPROCESSABLE,
                ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChatPermissionPolicy.parsePatch(Map.of("SUPERUSER", Map.of(
                "post_messages", true))), ErrorCategory.BAD_REQUEST,
                ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChatPermissionPolicy.parsePatch(Map.of("MEMBER", Map.of(
                "delete_everything", true))), ErrorCategory.BAD_REQUEST,
                ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChatPermissionPolicy.parsePatch(Map.of("MEMBER", Map.of())),
                ErrorCategory.UNPROCESSABLE, ErrorCode.VALIDATION_FAILED);
    }

    @Test
    void publicVisibilityRequiresOpenJoinPolicy() {
        assertThat(ChannelJoinPolicy.forVisibility(ChannelVisibility.PUBLIC))
                .isEqualTo(ChannelJoinPolicy.OPEN);
        assertThat(ChannelJoinPolicy.forVisibility(ChannelVisibility.PRIVATE))
                .isEqualTo(ChannelJoinPolicy.INVITE_ONLY);
        assertThat(ChannelJoinPolicy.OPEN.allowsAutomaticJoin()).isTrue();
        assertThat(ChannelJoinPolicy.INVITE_ONLY.allowsAutomaticJoin()).isFalse();
        assertThat(ChannelJoinPolicy.CLOSED.allowsAutomaticJoin()).isFalse();

        ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PUBLIC,
                ChannelJoinPolicy.OPEN);
        ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PRIVATE,
                ChannelJoinPolicy.OPEN);
        ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PRIVATE,
                ChannelJoinPolicy.INVITE_ONLY);
        ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PRIVATE,
                ChannelJoinPolicy.CLOSED);

        assertError(() -> ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PUBLIC,
                ChannelJoinPolicy.INVITE_ONLY), ErrorCategory.UNPROCESSABLE,
                ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChannelSettingsPolicy.requireCoherent(ChannelVisibility.PUBLIC,
                ChannelJoinPolicy.CLOSED), ErrorCategory.UNPROCESSABLE,
                ErrorCode.VALIDATION_FAILED);
    }

    @Test
    void settingsLiteralsAreValidatedWithSemanticErrors() {
        assertThat(ChannelSettingsPolicy.parseVisibility("PUBLIC"))
                .isEqualTo(ChannelVisibility.PUBLIC);
        assertThat(ChannelSettingsPolicy.parseVisibility("PRIVATE"))
                .isEqualTo(ChannelVisibility.PRIVATE);
        assertThat(ChannelSettingsPolicy.parseJoinPolicy("CLOSED"))
                .isEqualTo(ChannelJoinPolicy.CLOSED);
        assertError(() -> ChannelSettingsPolicy.parseVisibility("SECRET"),
                ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChannelSettingsPolicy.parseJoinPolicy("ANYONE"),
                ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED);
        assertError(() -> ChannelSettingsPolicy.parseJoinPolicy(""),
                ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED);
        assertThat(ChatPermission.fromWire("pin_messages"))
                .isEqualTo(ChatPermission.PIN_MESSAGES);
        assertThat(ChatPermission.fromWire("nope")).isNull();
        assertThat(ChatPermission.fromWire(null)).isNull();
        assertThat(ChatPermission.PIN_MESSAGES.wire()).isEqualTo("pin_messages");
    }

    private static Map<ChatPermission, Boolean> all(boolean value) {
        Map<ChatPermission, Boolean> rights = new java.util.EnumMap<>(ChatPermission.class);
        for (ChatPermission permission : ChatPermission.values()) {
            rights.put(permission, value);
        }
        return rights;
    }

    private static void assertError(org.assertj.core.api.ThrowableAssert.ThrowingCallable
                                            callable,
                                    ErrorCategory category, String code) {
        assertThatThrownBy(callable)
                .isInstanceOfSatisfying(DomainException.class, exception -> {
                    assertThat(exception.category()).isEqualTo(category);
                    assertThat(exception.code()).isEqualTo(code);
                });
    }
}
