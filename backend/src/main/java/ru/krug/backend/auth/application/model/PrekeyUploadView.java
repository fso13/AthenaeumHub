package ru.krug.backend.auth.application.model;

import java.time.Instant;
import java.util.UUID;

public record PrekeyUploadView(UUID deviceId, int keyGeneration, String signedPrekeyId,
                               Instant signedPrekeyExpiresAt, int oneTimePrekeysStored,
                               int oneTimePrekeysAvailable, int oneTimePrekeysLimit) {
}
