package ru.krug.backend.auth.api.dto;

import java.time.Instant;
import java.util.UUID;

public record PrekeyUploadResultResponse(UUID deviceId, int keyGeneration,
                                         String signedPrekeyId,
                                         Instant signedPrekeyExpiresAt,
                                         int oneTimePrekeysStored,
                                         int oneTimePrekeysAvailable,
                                         int oneTimePrekeysLimit) {
}
