package ru.krug.backend.file.application.model;

/** Transport-neutral quota numbers; the API maps this to PreflightResponse.quota. */
public record QuotaView(long used, long reserved, long limit) {

    public long total() {
        return used + reserved;
    }
}
