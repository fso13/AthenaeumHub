package ru.krug.backend.file.domain.model;

/**
 * Pure quota arithmetic. Framework-free so the invariant can be unit tested without a DB.
 * used = committed bytes, reserved = active reservations (not yet completed).
 */
public record QuotaUsage(long used, long reserved) {

    public QuotaUsage {
        if (used < 0 || reserved < 0) {
            throw new IllegalArgumentException("quota counters must be >= 0");
        }
    }

    public static QuotaUsage empty() {
        return new QuotaUsage(0, 0);
    }

    public long total() {
        return used + reserved;
    }

    public boolean canReserve(long bytes, long limit) {
        if (bytes <= 0 || limit <= 0) {
            return false;
        }
        return total() + bytes <= limit;
    }

    public QuotaUsage reserve(long bytes) {
        requirePositive(bytes);
        return new QuotaUsage(used, reserved + bytes);
    }

    /** ACTIVE -> COMMITTED: the object is now stored, so move reserved into used once. */
    public QuotaUsage commit(long bytes) {
        requirePositive(bytes);
        if (reserved < bytes) {
            throw new IllegalStateException("reserved quota is smaller than the reservation");
        }
        return new QuotaUsage(used + bytes, reserved - bytes);
    }

    /** release an ACTIVE reservation. */
    public QuotaUsage releaseReserved(long bytes) {
        requirePositive(bytes);
        if (reserved < bytes) {
            throw new IllegalStateException("reserved quota is smaller than the reservation");
        }
        return new QuotaUsage(used, reserved - bytes);
    }

    /** release a COMMITTED reservation (GC / quarantine). */
    public QuotaUsage releaseCommitted(long bytes) {
        requirePositive(bytes);
        if (used < bytes) {
            throw new IllegalStateException("used quota is smaller than the attachment");
        }
        return new QuotaUsage(used - bytes, reserved);
    }

    private static void requirePositive(long bytes) {
        if (bytes <= 0) {
            throw new IllegalArgumentException("quota delta must be > 0");
        }
    }
}
