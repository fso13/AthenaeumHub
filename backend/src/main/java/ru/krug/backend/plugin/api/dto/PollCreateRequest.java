package ru.krug.backend.plugin.api.dto;

import java.util.List;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** {@code POST /chats/{chatId}/polls} body. */
public record PollCreateRequest(
        @NotNull @Size(min = 1, max = 500) String question,
        @NotNull @Size(min = 2, max = 10)
        List<@NotBlank @Size(max = 200) String> options) {
}
