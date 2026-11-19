package ru.krug.backend.plugin.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** {@code POST /chats/{chatId}/messages/{messageId}/translate} body. */
public record TranslationRequest(
        @NotBlank @Size(min = 2, max = 16)
        @Pattern(regexp = "^[a-z]{2,3}(-[A-Za-z]{2,4})?$") String target) {
}
