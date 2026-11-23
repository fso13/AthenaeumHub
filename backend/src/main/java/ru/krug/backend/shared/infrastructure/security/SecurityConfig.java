package ru.krug.backend.shared.infrastructure.security;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.header.writers.DelegatingRequestMatcherHeaderWriter;
import org.springframework.security.web.header.writers.frameoptions.XFrameOptionsHeaderWriter;
import org.springframework.security.web.header.writers.frameoptions.XFrameOptionsHeaderWriter.XFrameOptionsMode;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;
import org.springframework.security.web.util.matcher.NegatedRequestMatcher;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

import ru.krug.backend.auth.infrastructure.security.AuthCsrfFilter;
import ru.krug.backend.auth.infrastructure.security.SessionActivityFilter;
import ru.krug.backend.bot.infrastructure.security.BotTokenAuthenticationFilter;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    /**
     * The bot filter is a {@code @Component} so the security chain can inject it; disable the
     * servlet-container auto-registration so it runs exactly once, inside its own chain.
     */
    @Bean
    public FilterRegistrationBean<BotTokenAuthenticationFilter> botTokenFilterRegistration(
            BotTokenAuthenticationFilter filter) {
        FilterRegistrationBean<BotTokenAuthenticationFilter> registration =
                new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    /**
     * #101: the activity filter is added to the user chain explicitly; disable the servlet
     * container auto-registration so it runs exactly once, after device binding.
     */
    /**
     * #103: the CSRF origin guard is added to the user chain only; disable the servlet
     * container auto-registration so it runs exactly once, after CORS and before controllers.
     */
    @Bean
    public FilterRegistrationBean<AuthCsrfFilter> authCsrfFilterRegistration(
            AuthCsrfFilter filter) {
        FilterRegistrationBean<AuthCsrfFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    public FilterRegistrationBean<SessionActivityFilter> sessionActivityFilterRegistration(
            SessionActivityFilter filter) {
        FilterRegistrationBean<SessionActivityFilter> registration =
                new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    /**
     * #96: dedicated chain for the bot-token API. It never falls back to JWT and does not run
     * the user device binding; the only matcher is {@code /api/v1/bots/**}, so a bot token can
     * reach exactly the message-send controller. Ordered before the user chain.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain botApiFilterChain(
            HttpSecurity http,
            BotTokenAuthenticationFilter botTokenAuthenticationFilter,
            RestAuthenticationEntryPoint authenticationEntryPoint,
            RestAccessDeniedHandler accessDeniedHandler) throws Exception {
        http
                .securityMatcher("/api/v1/bots/**")
                .csrf(AbstractHttpConfigurer::disable)
                .cors(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .requestCache(cache -> cache.disable())
                .sessionManagement(session -> session
                        .sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint(authenticationEntryPoint)
                        .accessDeniedHandler(accessDeniedHandler))
                .addFilterBefore(botTokenAuthenticationFilter, AuthorizationFilter.class);
        return http.build();
    }

    @Bean
    @Order(2)
    public SecurityFilterChain apiFilterChain(
            HttpSecurity http,
            JwtDecoder jwtDecoder,
            DeviceBindingFilter deviceBindingFilter,
            SessionActivityFilter sessionActivityFilter,
            AuthCsrfFilter authCsrfFilter,
            CorsConfigurationSource corsConfigurationSource,
            RestAuthenticationEntryPoint authenticationEntryPoint,
            RestAccessDeniedHandler accessDeniedHandler) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                // #103: credentialed CORS for the split-origin/dev SPA; the refresh cookie
                // itself is SameSite=Lax and scoped to /api/v1/auth.
                .cors(cors -> cors.configurationSource(corsConfigurationSource))
                // D1.2 (#86): plugin assets are rendered in a sandboxed iframe, so the
                // default DENY would make the documented entry_url unusable. Only the
                // asset path is exempt; every other response keeps X-Frame-Options DENY.
                // The asset itself still carries CSP frame-ancestors 'self'.
                .headers(headers -> headers
                        .frameOptions(frame -> frame.disable())
                        .addHeaderWriter(new DelegatingRequestMatcherHeaderWriter(
                                new NegatedRequestMatcher(new AntPathRequestMatcher(
                                        "/api/v1/plugins/*/assets/**")),
                                new XFrameOptionsHeaderWriter(XFrameOptionsMode.DENY))))
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/v1/health", "/api/v1/dev/session", "/error",
                                "/ws", "/api/v1/auth/**", "/api/v1/setup/status",
                                // #98: the one-time response capability is the credential;
                                // there is no user JWT or bot bearer on this endpoint.
                                "/api/v1/bot-responses/**").permitAll()
                        // #100: anonymous invite preview. The unguessable token is the only
                        // credential and the response has no secrets. POST .../accept
                        // still requires a session.
                        .requestMatchers(HttpMethod.GET, "/api/v1/workspace-invites/*")
                        .permitAll()
                        .anyRequest().authenticated())
                .oauth2ResourceServer(oauth2 -> oauth2
                        .jwt(jwt -> jwt.decoder(jwtDecoder))
                        .authenticationEntryPoint(authenticationEntryPoint))
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint(authenticationEntryPoint)
                        .accessDeniedHandler(accessDeniedHandler))
                .addFilterAfter(deviceBindingFilter, BearerTokenAuthenticationFilter.class)
                .addFilterAfter(sessionActivityFilter, DeviceBindingFilter.class)
                .addFilterBefore(authCsrfFilter, CorsFilter.class);
        return http.build();
    }
}
