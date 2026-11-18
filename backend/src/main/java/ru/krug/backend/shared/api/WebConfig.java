package ru.krug.backend.shared.api;

import java.util.List;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final PrincipalArgumentResolver principalArgumentResolver;

    public WebConfig(PrincipalArgumentResolver principalArgumentResolver) {
        this.principalArgumentResolver = principalArgumentResolver;
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(principalArgumentResolver);
    }
}
