package ru.krug.backend.chat.domain.model;

/**
 * GROUP channel audience. PUBLIC channels are workspace-wide: every ACTIVE member is a
 * participant and every future member joins automatically. PRIVATE channels contain only
 * the creator and the selected ACTIVE workspace members. DIRECT chats have no visibility.
 */
public enum ChannelVisibility {
    PUBLIC,
    PRIVATE
}
