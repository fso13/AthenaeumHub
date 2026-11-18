package ru.krug.backend.file.infrastructure.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * FilesProperties is needed in every storage mode (memory tests included) because the
 * settings adapter and schedulers read TTL/batch sizes from it.
 */
@Configuration
@EnableConfigurationProperties(FilesProperties.class)
public class FilesConfig {
}
