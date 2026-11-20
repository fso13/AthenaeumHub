package ru.krug.backend.chat.api.dto;

import java.util.List;
import java.util.UUID;

import jakarta.validation.constraints.Size;

/**
 * OpenAPI {@code ChatCreateRequest}; type/visibility semantics are validated by the
 * application service. {@code member_ids} is PRIVATE-GROUP-only (1..100 distinct ACTIVE
 * workspace members, creator excluded). No private-channel invite links exist yet.
 */
public record ChatCreateRequest(String type, UUID peerId,
                                @Size(max = 120) String name,
                                String visibility,
                                List<UUID> memberIds) {
}
