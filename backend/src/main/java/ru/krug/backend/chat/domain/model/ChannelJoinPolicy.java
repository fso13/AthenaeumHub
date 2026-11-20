package ru.krug.backend.chat.domain.model;

/**
 * GROUP channel join policy (P0-2 / #80). Independent of visibility:
 *
 * <ul>
 *   <li>{@link #OPEN} — the channel is workspace-wide: every ACTIVE workspace member is a
 *       participant and future members join automatically (only coherent with
 *       {@link ChannelVisibility#PUBLIC}, enforced by the application);</li>
 *   <li>{@link #INVITE_ONLY} — a NEW participant joins through an invite link or an
 *       OWNER/ADMIN add; existing participants keep access;</li>
 *   <li>{@link #CLOSED} — new participants are only added by an OWNER/ADMIN; invite links
 *       answer {@code 403 CHAT_JOIN_CLOSED}.</li>
 * </ul>
 */
public enum ChannelJoinPolicy {
    OPEN,
    INVITE_ONLY,
    CLOSED;

    public static ChannelJoinPolicy fromWire(String value) {
        return valueOf(value);
    }

    public static ChannelJoinPolicy forVisibility(ChannelVisibility visibility) {
        return visibility == ChannelVisibility.PUBLIC ? OPEN : INVITE_ONLY;
    }

    /** True when a workspace member may be joined automatically (PUBLIC + OPEN). */
    public boolean allowsAutomaticJoin() {
        return this == OPEN;
    }
}
