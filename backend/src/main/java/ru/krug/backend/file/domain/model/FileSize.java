package ru.krug.backend.file.domain.model;

/**
 * Positive file size in bytes. The value object only protects "positive"; tariff policy is
 * checked by the application so the error carries limit/actual/tariff details.
 */
public record FileSize(long bytes) {

    public static final int DEFAULT_PART_SIZE = 8 * 1024 * 1024;
    public static final int MAX_PARTS = 10_000;

    public FileSize {
        if (bytes <= 0) {
            throw new IllegalArgumentException("file size must be > 0");
        }
    }

    public static FileSize of(long bytes) {
        return new FileSize(bytes);
    }

    public int totalParts(int partSize) {
        if (partSize <= 0) {
            throw new IllegalArgumentException("part size must be > 0");
        }
        long parts = (bytes + partSize - 1) / partSize;
        if (parts > MAX_PARTS) {
            throw new IllegalArgumentException("file needs more than " + MAX_PARTS + " parts");
        }
        return (int) parts;
    }

    public long partLength(int partNo, int partSize, int totalParts) {
        if (partNo < 1 || partNo > totalParts) {
            throw new IllegalArgumentException("part number outside 1.." + totalParts);
        }
        if (partNo < totalParts) {
            return partSize;
        }
        return bytes - (long) (totalParts - 1) * partSize;
    }
}
