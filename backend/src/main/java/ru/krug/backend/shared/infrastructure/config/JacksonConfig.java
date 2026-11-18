package ru.krug.backend.shared.infrastructure.config;

import com.fasterxml.jackson.core.JsonParser;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * E2EE-REVIEW-06 P2-04: duplicate JSON keys are a parser differential (last-wins on the
 * server, first-wins in a proxy/audit reader). Reject them for every API request body.
 * The setting is global on the HTTP ObjectMapper; response serialization is unaffected.
 */
@Configuration
public class JacksonConfig {

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer strictDuplicateJsonKeys() {
        return builder -> builder.featuresToEnable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    }
}
