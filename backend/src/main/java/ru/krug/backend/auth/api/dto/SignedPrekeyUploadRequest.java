package ru.krug.backend.auth.api.dto;

import java.util.List;

public record SignedPrekeyUploadRequest(SignedPrekeyRequest signedPrekey,
                                        List<OneTimePrekeyRequest> oneTimePrekeys) {
}
