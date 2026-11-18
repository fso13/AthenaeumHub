package ru.krug.backend.file.infrastructure.config;

import java.net.URI;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

/** S3/MinIO client beans. Only created when krug.files.storage=s3 (default). */
@Configuration
@ConditionalOnProperty(name = "krug.files.storage", havingValue = "s3", matchIfMissing = true)
public class ObjectStorageConfig {

    @Bean
    public S3Client s3Client(FilesProperties properties) {
        return S3Client.builder()
                .endpointOverride(URI.create(properties.getEndpoint()))
                .region(Region.of(properties.getRegion()))
                .credentialsProvider(credentials(properties))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(properties.isPathStyle())
                        .build())
                .build();
    }

    @Bean
    public S3Presigner s3Presigner(FilesProperties properties) {
        String publicEndpoint = properties.getPublicEndpoint();
        String presignEndpoint = publicEndpoint == null || publicEndpoint.isBlank()
                ? properties.getEndpoint() : publicEndpoint;
        return S3Presigner.builder()
                .endpointOverride(URI.create(presignEndpoint))
                .region(Region.of(properties.getRegion()))
                .credentialsProvider(credentials(properties))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(properties.isPathStyle())
                        .build())
                .build();
    }

    private static StaticCredentialsProvider credentials(FilesProperties properties) {
        return StaticCredentialsProvider.create(AwsBasicCredentials.create(
                properties.getAccessKey(), properties.getSecretKey()));
    }
}
