package ru.krug.backend.chat.application.model;

/** Add-member result: the member row plus whether a participant row was actually written. */
public record ChatMemberAddResult(ChatMemberView member, boolean created) {
}
