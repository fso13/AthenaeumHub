package ru.krug.backend.chat.domain.model;

/**
 * Channel-level rights that can be configured per chat role (P0-2 / #80). The wire value is
 * the OpenAPI {@code permission} property name and is also the
 * {@code chat.chat_permissions.permission} CHECK literal.
 *
 * <p>Every right is evaluated server-side before the corresponding action: message send,
 * invite creation/member add, poll creation, call offer, pin/unpin and channel-info edit
 * (cover/name/description). See {@code ChatPermissionPolicy} for the defaults.</p>
 */
public enum ChatPermission {
    POST_MESSAGES("post_messages"),
    INVITE_MEMBERS("invite_members"),
    CREATE_POLLS("create_polls"),
    START_CALLS("start_calls"),
    PIN_MESSAGES("pin_messages"),
    CHANGE_INFO("change_info");

    private final String wire;

    ChatPermission(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** Returns {@code null} for an unknown value; callers answer a semantic 400. */
    public static ChatPermission fromWire(String value) {
        if (value == null) {
            return null;
        }
        for (ChatPermission permission : values()) {
            if (permission.wire.equals(value)) {
                return permission;
            }
        }
        return null;
    }
}
