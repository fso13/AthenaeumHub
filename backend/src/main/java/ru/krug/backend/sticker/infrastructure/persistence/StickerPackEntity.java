package ru.krug.backend.sticker.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** JPA read model for the global built-in catalog (writes only from the seed function). */
@Entity
@Table(name = "sticker_packs", schema = "sticker")
public class StickerPackEntity {

    @Id
    private UUID id;

    @Column(name = "slug", nullable = false)
    private String slug;

    @Column(name = "name", nullable = false)
    private String name;

    @Column(name = "cover_url", nullable = false)
    private String coverUrl;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "builtin", nullable = false)
    private boolean builtin;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected StickerPackEntity() {
    }

    public UUID getId() {
        return id;
    }

    public String getSlug() {
        return slug;
    }

    public String getName() {
        return name;
    }

    public String getCoverUrl() {
        return coverUrl;
    }

    public String getStatus() {
        return status;
    }

    public boolean isBuiltin() {
        return builtin;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
