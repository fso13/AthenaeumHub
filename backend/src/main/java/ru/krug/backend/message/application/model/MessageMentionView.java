package ru.krug.backend.message.application.model;

import java.util.List;
import java.util.UUID;

/** Mention payload of one message: explicit ids and the @all marker. */
public record MessageMentionView(List<UUID> userIds, boolean all) {

    public MessageMentionView {
        userIds = userIds == null ? List.of() : List.copyOf(userIds);
    }

    public static MessageMentionView empty() {
        return new MessageMentionView(List.of(), false);
    }
}
