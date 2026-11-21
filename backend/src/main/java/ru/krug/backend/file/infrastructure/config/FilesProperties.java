package ru.krug.backend.file.infrastructure.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** E4-B files configuration. Env variables are documented in backend/README.md. */
@ConfigurationProperties(prefix = "krug.files")
public class FilesProperties {

    /** s3 | memory. "memory" is used by the test profile. */
    private String storage = "s3";
    private String bucket = "krug";
    private String region = "us-east-1";
    private String endpoint = "http://localhost:9002";
    /**
     * Public endpoint used only for presigned download URLs. In a container
     * deployment the S3 API is reachable as http://minio:9000, while the browser
     * must use the published endpoint (for example http://localhost:9002).
     * Blank means "use endpoint".
     */
    private String publicEndpoint = "";
    private String accessKey = "minioadmin";
    private String secretKey = "minioadmin";
    private boolean pathStyle = true;
    private Duration uploadTtl = Duration.ofHours(24);
    private Duration downloadTtl = Duration.ofMinutes(5);
    /**
     * Absolute public API origin used only to build {@code media.artwork_url} for
     * server-extracted audio covers (#97). Blank disables the advertised URL; the
     * authenticated {@code GET /attachments/{id}/artwork} endpoint keeps working.
     */
    private String artworkBaseUrl = "";

    /** noop | clamav. */
    private String scanMode = "noop";
    /** Dev-only marker: a filename containing it makes NoopScanner return INFECTED. */
    private String noopFailMarker = "";
    private String clamavHost = "localhost";
    private int clamavPort = 3310;
    private Duration scanPollInterval = Duration.ofSeconds(2);
    private int scanBatchSize = 50;
    private boolean scanEnabled = true;

    private boolean gcEnabled = true;
    private Duration gcPollInterval = Duration.ofMinutes(10);
    private int gcBatchSize = 100;

    private boolean reconcileEnabled = true;
    private Duration reconcileInitialDelay = Duration.ofMinutes(1);
    private Duration reconcileInterval = Duration.ofHours(24);
    private int reconcileBatchSize = 1000;

    public String getStorage() {
        return storage;
    }

    public void setStorage(String storage) {
        this.storage = storage;
    }

    public String getBucket() {
        return bucket;
    }

    public void setBucket(String bucket) {
        this.bucket = bucket;
    }

    public String getRegion() {
        return region;
    }

    public void setRegion(String region) {
        this.region = region;
    }

    public String getEndpoint() {
        return endpoint;
    }

    public void setEndpoint(String endpoint) {
        this.endpoint = endpoint;
    }

    public String getPublicEndpoint() {
        return publicEndpoint;
    }

    public void setPublicEndpoint(String publicEndpoint) {
        this.publicEndpoint = publicEndpoint;
    }

    public String getAccessKey() {
        return accessKey;
    }

    public void setAccessKey(String accessKey) {
        this.accessKey = accessKey;
    }

    public String getSecretKey() {
        return secretKey;
    }

    public void setSecretKey(String secretKey) {
        this.secretKey = secretKey;
    }

    public boolean isPathStyle() {
        return pathStyle;
    }

    public void setPathStyle(boolean pathStyle) {
        this.pathStyle = pathStyle;
    }

    public Duration getUploadTtl() {
        return uploadTtl;
    }

    public void setUploadTtl(Duration uploadTtl) {
        this.uploadTtl = uploadTtl;
    }

    public Duration getDownloadTtl() {
        return downloadTtl;
    }

    public void setDownloadTtl(Duration downloadTtl) {
        this.downloadTtl = downloadTtl;
    }

    public String getArtworkBaseUrl() {
        return artworkBaseUrl;
    }

    public void setArtworkBaseUrl(String artworkBaseUrl) {
        this.artworkBaseUrl = artworkBaseUrl;
    }

    public String getScanMode() {
        return scanMode;
    }

    public void setScanMode(String scanMode) {
        this.scanMode = scanMode;
    }

    public String getNoopFailMarker() {
        return noopFailMarker;
    }

    public void setNoopFailMarker(String noopFailMarker) {
        this.noopFailMarker = noopFailMarker;
    }

    public String getClamavHost() {
        return clamavHost;
    }

    public void setClamavHost(String clamavHost) {
        this.clamavHost = clamavHost;
    }

    public int getClamavPort() {
        return clamavPort;
    }

    public void setClamavPort(int clamavPort) {
        this.clamavPort = clamavPort;
    }

    public Duration getScanPollInterval() {
        return scanPollInterval;
    }

    public void setScanPollInterval(Duration scanPollInterval) {
        this.scanPollInterval = scanPollInterval;
    }

    public int getScanBatchSize() {
        return scanBatchSize;
    }

    public void setScanBatchSize(int scanBatchSize) {
        this.scanBatchSize = scanBatchSize;
    }

    public boolean isScanEnabled() {
        return scanEnabled;
    }

    public void setScanEnabled(boolean scanEnabled) {
        this.scanEnabled = scanEnabled;
    }

    public boolean isGcEnabled() {
        return gcEnabled;
    }

    public void setGcEnabled(boolean gcEnabled) {
        this.gcEnabled = gcEnabled;
    }

    public Duration getGcPollInterval() {
        return gcPollInterval;
    }

    public void setGcPollInterval(Duration gcPollInterval) {
        this.gcPollInterval = gcPollInterval;
    }

    public int getGcBatchSize() {
        return gcBatchSize;
    }

    public void setGcBatchSize(int gcBatchSize) {
        this.gcBatchSize = gcBatchSize;
    }

    public boolean isReconcileEnabled() {
        return reconcileEnabled;
    }

    public void setReconcileEnabled(boolean reconcileEnabled) {
        this.reconcileEnabled = reconcileEnabled;
    }

    public Duration getReconcileInitialDelay() {
        return reconcileInitialDelay;
    }

    public void setReconcileInitialDelay(Duration reconcileInitialDelay) {
        this.reconcileInitialDelay = reconcileInitialDelay;
    }

    public Duration getReconcileInterval() {
        return reconcileInterval;
    }

    public void setReconcileInterval(Duration reconcileInterval) {
        this.reconcileInterval = reconcileInterval;
    }

    public int getReconcileBatchSize() {
        return reconcileBatchSize;
    }

    public void setReconcileBatchSize(int reconcileBatchSize) {
        this.reconcileBatchSize = reconcileBatchSize;
    }
}
