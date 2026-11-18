package ru.krug.backend.chat.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.Size;

/** OpenAPI {@code ChatCreateRequest}; type is validated by the application service. */
public record ChatCreateRequest(String type, UUID peerId,
                                @Size(max = 120) String name) {
}
