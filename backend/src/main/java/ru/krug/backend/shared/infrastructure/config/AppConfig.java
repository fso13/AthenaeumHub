package ru.krug.backend.shared.infrastructure.config;

import java.time.Clock;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import ru.krug.backend.shared.application.port.ClockPort;

@Configuration
public class AppConfig {

    @Bean
    public ClockPort clockPort() {
        Clock clock = Clock.systemUTC();
        return clock::instant;
    }
}
