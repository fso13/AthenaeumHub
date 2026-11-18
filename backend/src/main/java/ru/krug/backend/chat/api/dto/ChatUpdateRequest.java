package ru.krug.backend.chat.api.dto;

/**
 * {@code PATCH /chats/{chatId}} body (D1-BE3). Absent/null fields are not changed;
 * {@code description: ""} clears the description. Length/plain-text checks are performed
 * in the application layer so violations return a semantic {@code 422} with details.
 */
public record ChatUpdateRequest(String name, String description) {
}
