package ru.krug.backend.support;

import jakarta.servlet.http.Cookie;

import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/** #103 helpers for asserting and replaying the HttpOnly refresh cookie. */
public final class AuthCookieTestSupport {

    public static final String COOKIE = "sova_refresh";

    private AuthCookieTestSupport() {
    }

    /** Last {@code Set-Cookie} header of the response, or {@code null}. */
    public static String setCookie(MvcResult result) {
        java.util.List<String> headers =
                result.getResponse().getHeaders("Set-Cookie");
        return headers.isEmpty() ? null : headers.get(headers.size() - 1);
    }

    public static String value(MvcResult result) {
        String header = setCookie(result);
        if (header == null) {
            return null;
        }
        String prefix = COOKIE + "=";
        int start = header.indexOf(prefix);
        if (start < 0) {
            return null;
        }
        start += prefix.length();
        int end = header.indexOf(';', start);
        return end < 0 ? header.substring(start) : header.substring(start, end);
    }

    public static Cookie cookie(MvcResult result) {
        String value = value(result);
        return value == null || value.isEmpty() ? null : new Cookie(COOKIE, value);
    }

    public static MockHttpServletRequestBuilder withCookie(
            MockHttpServletRequestBuilder builder, String value) {
        return builder.cookie(new Cookie(COOKIE, value));
    }
}
