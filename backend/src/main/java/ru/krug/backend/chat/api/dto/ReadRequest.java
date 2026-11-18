package ru.krug.backend.chat.api.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

public record ReadRequest(@NotNull @Min(0) Long lastSeq) {
}
