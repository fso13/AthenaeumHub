package ru.krug.backend.sticker.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** JPA read model for a sticker row; never an API/domain type. */
@Entity
@Table(name = "stickers", schema = "sticker")
public class StickerEntity {

    @Id
    private UUID id;

    @Column(name = "pack_id", nullable = false)
    private UUID packId;

    @Column(name = "alt", nullable = false)
    private String alt;

    @Column(name = "url", nullable = false)
    private String url;

    @Column(name = "format", nullable = false)
    private String format;

    @Column(name = "width", nullable = false)
    private int width;

    @Column(name = "height", nullable = false)
    private int height;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "position", nullable = false)
    private int position;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected StickerEntity() {
    }

    public UUID getId() {
        return id;
    }

    public UUID getPackId() {
        return packId;
    }

    public String getAlt() {
        return alt;
    }

    public String getUrl() {
        return url;
    }

    public String getFormat() {
        return format;
    }

    public int getWidth() {
        return width;
    }

    public int getHeight() {
        return height;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public int getPosition() {
        return position;
    }

    public String getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
