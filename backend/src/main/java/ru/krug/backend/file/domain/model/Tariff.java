package ru.krug.backend.file.domain.model;

/**
 * Tariff limits from SYSTEM-ANALYSIS §12.1. Defaults are mirrored in V9 backfill so an
 * existing workspace immediately behaves like TEAM before any explicit plan change.
 */
public enum Tariff {
    COMMUNITY(200L * 1024 * 1024, 10L * 1024 * 1024 * 1024, 5,
            100L * 1024 * 1024, 12),
    FAMILY(1024L * 1024 * 1024, 100L * 1024 * 1024 * 1024, 10,
            500L * 1024 * 1024, 24),
    TEAM(2L * 1024 * 1024 * 1024, 1024L * 1024 * 1024 * 1024, 10,
            500L * 1024 * 1024, 12),
    ENTERPRISE(10L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024 * 1024, 10,
            2L * 1024 * 1024 * 1024, 12);

    private final long maxFileBytes;
    private final long storageBytes;
    private final int maxAttachments;
    private final long guestFileBytes;
    private final int retentionMonths;

    Tariff(long maxFileBytes, long storageBytes, int maxAttachments, long guestFileBytes,
           int retentionMonths) {
        this.maxFileBytes = maxFileBytes;
        this.storageBytes = storageBytes;
        this.maxAttachments = maxAttachments;
        this.guestFileBytes = guestFileBytes;
        this.retentionMonths = retentionMonths;
    }

    public long maxFileBytes() {
        return maxFileBytes;
    }

    public long storageBytes() {
        return storageBytes;
    }

    public int maxAttachments() {
        return maxAttachments;
    }

    public long guestFileBytes() {
        return guestFileBytes;
    }

    public int retentionMonths() {
        return retentionMonths;
    }

    public static Tariff from(String value) {
        if (value == null) {
            return TEAM;
        }
        try {
            return valueOf(value);
        } catch (IllegalArgumentException ex) {
            return TEAM;
        }
    }
}
