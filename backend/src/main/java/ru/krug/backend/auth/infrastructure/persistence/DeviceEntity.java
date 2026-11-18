package ru.krug.backend.auth.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "devices", schema = "auth")
public class DeviceEntity {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "name", nullable = false)
    private String name;

    @Column(name = "platform", nullable = false)
    private String platform;

    @Column(name = "app_version", nullable = false)
    private String appVersion;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "key_generation", nullable = false)
    private Integer keyGeneration;

    @Column(name = "identity_key_alg", nullable = false)
    private String identityKeyAlg;

    @Column(name = "identity_signing_key")
    private byte[] identitySigningKey;

    @Column(name = "identity_dh_key")
    private byte[] identityDhKey;

    @Column(name = "identity_binding_signature")
    private byte[] identityBindingSignature;

    @Column(name = "fingerprint")
    private byte[] fingerprint;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "last_seen_at")
    private Instant lastSeenAt;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    protected DeviceEntity() {
    }

    public UUID getId() {
        return id;
    }

    public UUID getUserId() {
        return userId;
    }

    public String getName() {
        return name;
    }

    public String getPlatform() {
        return platform;
    }

    public String getAppVersion() {
        return appVersion;
    }

    public String getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public String getIdentityKeyAlg() {
        return identityKeyAlg;
    }

    public byte[] getIdentitySigningKey() {
        return identitySigningKey;
    }

    public byte[] getIdentityDhKey() {
        return identityDhKey;
    }

    public byte[] getIdentityBindingSignature() {
        return identityBindingSignature;
    }

    public byte[] getFingerprint() {
        return fingerprint;
    }

    public Integer getKeyGeneration() {
        return keyGeneration;
    }

    public Instant getLastSeenAt() {
        return lastSeenAt;
    }

    public Instant getRevokedAt() {
        return revokedAt;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public void setUserId(UUID userId) {
        this.userId = userId;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setPlatform(String platform) {
        this.platform = platform;
    }

    public void setAppVersion(String appVersion) {
        this.appVersion = appVersion;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public void setKeyGeneration(Integer keyGeneration) {
        this.keyGeneration = keyGeneration;
    }

    public void setIdentityKeyAlg(String identityKeyAlg) {
        this.identityKeyAlg = identityKeyAlg;
    }

    public void setIdentitySigningKey(byte[] identitySigningKey) {
        this.identitySigningKey = identitySigningKey;
    }

    public void setIdentityDhKey(byte[] identityDhKey) {
        this.identityDhKey = identityDhKey;
    }

    public void setIdentityBindingSignature(byte[] identityBindingSignature) {
        this.identityBindingSignature = identityBindingSignature;
    }

    public void setFingerprint(byte[] fingerprint) {
        this.fingerprint = fingerprint;
    }

    public void setLastSeenAt(Instant lastSeenAt) {
        this.lastSeenAt = lastSeenAt;
    }

    public void setRevokedAt(Instant revokedAt) {
        this.revokedAt = revokedAt;
    }
}
