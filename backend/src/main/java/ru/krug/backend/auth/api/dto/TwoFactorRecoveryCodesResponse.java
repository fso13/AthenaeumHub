package ru.krug.backend.auth.api.dto;

import java.util.List;

/** One-time recovery codes; returned exactly once. */
public record TwoFactorRecoveryCodesResponse(List<String> codes, long remaining) {
}
