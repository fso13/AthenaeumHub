package ru.krug.backend.shared.infrastructure.security;

import java.io.IOException;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.api.dto.ApiError;
import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.error.ErrorCode;

@Component
public class RestAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final ObjectMapper objectMapper;

    public RestAuthenticationEntryPoint(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
                         AuthenticationException authException) throws IOException {
        boolean deviceMismatch = "device_mismatch".equals(
                request.getAttribute(DeviceBindingFilter.REASON_ATTRIBUTE));
        boolean expired = hasExpiredCause(authException);

        String code = expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.UNAUTHENTICATED;
        String message = deviceMismatch
                ? "X-Device-Id header is missing or does not match the access token"
                : expired ? "Access token expired" : "Authentication required";

        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(response.getWriter(),
                new ApiError(code, message, Map.of(), RequestIdFilter.requestId(request)));
    }

    private static boolean hasExpiredCause(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof OAuth2AuthenticationException oauth2Ex) {
                OAuth2Error error = oauth2Ex.getError();
                if (error != null && containsExpired(error.getDescription())) {
                    return true;
                }
            }
            if (current instanceof JwtException && containsExpired(current.getMessage())) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static boolean containsExpired(String value) {
        return value != null && value.toLowerCase().contains("expired");
    }
}
