package ru.krug.backend.bot.infrastructure.security;

import java.io.IOException;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ru.krug.backend.bot.application.model.BotPrincipal;
import ru.krug.backend.bot.application.usecase.BotTokenAuthenticator;
import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.infrastructure.web.ApiRequestPath;

/**
 * Authenticates the dedicated bot API ({@code /api/v1/bots/{botId}/messages}) from
 * {@code Authorization: Bearer sova_bot_...}.
 *
 * <p>Security notes: the header/token is never logged; a malformed token, a token for another
 * bot id, a disabled bot and an unknown bot all produce the same generic 401. The raw token
 * leaves memory only into the tenant-scoped authenticator, which compares SHA-256 hashes in
 * constant time.</p>
 */
@Component
public class BotTokenAuthenticationFilter extends OncePerRequestFilter {

    private static final String HEADER = "Authorization";
    private static final String BEARER = "Bearer ";
    private static final Pattern BOT_MESSAGES_PATH =
            Pattern.compile("^/api/v1/bots/([0-9a-fA-F-]{36})/messages$");

    private final BotTokenAuthenticator authenticator;
    private final AuthenticationEntryPoint authenticationEntryPoint;

    public BotTokenAuthenticationFilter(BotTokenAuthenticator authenticator,
                                        AuthenticationEntryPoint authenticationEntryPoint) {
        this.authenticator = authenticator;
        this.authenticationEntryPoint = authenticationEntryPoint;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        // This filter bean may also be picked up by the servlet container's filter
        // auto-registration. Restrict every invocation to the one bot path so a user's JWT
        // Bearer header on any other route is never interpreted as a bot token.
        UUID pathBotId = pathBotId(request);
        if (pathBotId == null) {
            filterChain.doFilter(request, response);
            return;
        }

        String header = request.getHeader(HEADER);
        if (header == null || !header.regionMatches(true, 0, BEARER, 0, BEARER.length())) {
            // No bot credential: the authorization filter answers 401 through the entry point.
            filterChain.doFilter(request, response);
            return;
        }

        String rawToken = header.substring(BEARER.length()).trim();
        Optional<BotPrincipal> principal = authenticator.authenticate(rawToken, pathBotId,
                RequestIdFilter.requestId(request));
        if (principal.isEmpty()) {
            SecurityContextHolder.clearContext();
            authenticationEntryPoint.commence(request, response,
                    new BadCredentialsException("Invalid bot token"));
            return;
        }

        BotPrincipal bot = principal.get();
        var authentication = UsernamePasswordAuthenticationToken.authenticated(bot, null,
                List.of(new SimpleGrantedAuthority("ROLE_BOT")));
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(authentication);
        SecurityContextHolder.setContext(context);
        filterChain.doFilter(request, response);
    }

    private static UUID pathBotId(HttpServletRequest request) {
        String path;
        try {
            path = ApiRequestPath.normalized(request);
        } catch (ApiRequestPath.InvalidPathException ex) {
            return null;
        }
        Matcher matcher = BOT_MESSAGES_PATH.matcher(path);
        if (!matcher.matches()) {
            return null;
        }
        try {
            return UUID.fromString(matcher.group(1));
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
