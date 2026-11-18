package ru.krug.backend.shared.infrastructure.web;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ru.krug.backend.shared.api.RequestIdFilter;
import ru.krug.backend.shared.api.dto.ApiError;
import ru.krug.backend.shared.application.model.PayloadLimits;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Enforces the E2EE message wire limit (512 KiB) <b>before</b> JSON parsing. Content-Length
 * may be absent (chunked), so the body is read once, bounded to {@code limit + 1} bytes, and
 * replaced by a cached copy for the argument resolver. Never logs or stores the body.
 *
 * <p>E2EE-REVIEW-06 P1-01: the route predicate runs on the decoded path
 * ({@link ApiRequestPath}), so {@code POST /api/v1/chats/{id}/%6Dessages} cannot bypass the
 * limit. Malformed percent-encoding/traversal is rejected before any body read.
 */
@Component
@Order(0)
public class PayloadLimitFilter extends OncePerRequestFilter {

    private static final Pattern MESSAGE_SEND = Pattern.compile("^/api/v1/chats/[^/]+/messages$");
    private static final int MAX_BYTES = PayloadLimits.MESSAGE_WIRE_BYTES;

    private final ObjectMapper objectMapper;

    public PayloadLimitFilter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Every API path is inspected so an invalid path is rejected before dispatch; the
        // body is only read for POST .../messages.
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path;
        try {
            path = ApiRequestPath.normalized(request);
        } catch (ApiRequestPath.InvalidPathException ex) {
            writeError(response, HttpServletResponse.SC_NOT_FOUND, ErrorCode.NOT_FOUND,
                    "Resource not found", Map.of(), request);
            return;
        }
        if (!"POST".equalsIgnoreCase(request.getMethod())
                || !MESSAGE_SEND.matcher(path).matches()) {
            filterChain.doFilter(request, response);
            return;
        }
        byte[] body = readBounded(request.getInputStream(), MAX_BYTES + 1);
        if (body.length > MAX_BYTES) {
            writeError(response, HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE,
                    ErrorCode.PAYLOAD_TOO_LARGE, "Request body exceeds 512 KiB",
                    Map.of("limit", MAX_BYTES, "reason", "wire"), request);
            return;
        }
        filterChain.doFilter(new CachedBodyHttpServletRequest(request, body), response);
    }

    private void writeError(HttpServletResponse response, int status, String code, String message,
                            Map<String, Object> details, HttpServletRequest request)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(response.getOutputStream(), new ApiError(code, message, details,
                RequestIdFilter.requestId(request)));
    }

    private static byte[] readBounded(InputStream input, int max) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(Math.min(max, 8192));
        byte[] chunk = new byte[8192];
        int total = 0;
        int read;
        // Stop at max + 1 bytes: that sentinel is enough to answer 413 and prevents an
        // arbitrary body from being buffered in memory.
        while (total <= max && (read = input.read(chunk)) != -1) {
            int allowed = Math.min(read, max + 1 - total);
            buffer.write(chunk, 0, allowed);
            total += allowed;
        }
        return buffer.toByteArray();
    }
}
