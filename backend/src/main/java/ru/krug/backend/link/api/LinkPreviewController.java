package ru.krug.backend.link.api;

import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal server-side Open Graph reader. The browser cannot read cross-origin
 * metadata; this endpoint fetches one HTML page with a hard timeout and no
 * redirects, rejects private-network hosts and returns only title/description/
 * image. No page HTML or cookies leave the server.
 */
@RestController
public class LinkPreviewController {

    private static final int MAX_BYTES = 512 * 1024;
    private static final Pattern TITLE = Pattern.compile(
            "<title[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern OG = Pattern.compile(
            "<meta[^>]+(?:property|name)=[\"'](og:[^\"']+)[\"'][^>]+content=[\"']([^\"']*)[\"']",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OG_REVERSED = Pattern.compile(
            "<meta[^>]+content=[\"']([^\"']*)[\"'][^>]+(?:property|name)=[\"'](og:[^\"']+)[\"']",
            Pattern.CASE_INSENSITIVE);

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    public record Preview(String url, String title, String description, String image) {
    }

    @GetMapping("/api/v1/link-preview")
    public ResponseEntity<Preview> preview(@RequestParam String url) {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().build();
        }
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
            return ResponseEntity.badRequest().build();
        }
        if (uri.getHost() == null || isPrivateHost(uri.getHost())) {
            return ResponseEntity.badRequest().build();
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(4))
                    .header("User-Agent", "SovaLinkPreview/1.0")
                    .header("Accept", "text/html")
                    .GET()
                    .build();
            HttpResponse<byte[]> response = client.send(request,
                    HttpResponse.BodyHandlers.ofByteArray());
            String type = response.headers().firstValue("content-type").orElse("");
            if (response.statusCode() < 200 || response.statusCode() >= 300
                    || !type.toLowerCase(Locale.ROOT).contains("text/html")) {
                return ResponseEntity.notFound().build();
            }
            byte[] body = response.body();
            if (body.length > MAX_BYTES) {
                body = java.util.Arrays.copyOf(body, MAX_BYTES);
            }
            String html = new String(body, StandardCharsets.UTF_8);
            String title = meta(html, "og:title");
            if (title == null) {
                Matcher matcher = TITLE.matcher(html);
                title = matcher.find() ? clean(matcher.group(1)) : null;
            }
            String description = meta(html, "og:description");
            if (description == null) {
                description = meta(html, "description");
            }
            String image = meta(html, "og:image");
            if (title == null && description == null && image == null) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePublic())
                    .body(new Preview(uri.toString(), trim(title, 180), trim(description, 300),
                            image));
        } catch (Exception ex) {
            return ResponseEntity.notFound().build();
        }
    }

    private static String meta(String html, String name) {
        Matcher first = OG.matcher(html);
        while (first.find()) {
            if (first.group(1).equalsIgnoreCase(name)) return clean(first.group(2));
        }
        Matcher reversed = OG_REVERSED.matcher(html);
        while (reversed.find()) {
            if (reversed.group(2).equalsIgnoreCase(name)) return clean(reversed.group(1));
        }
        return null;
    }

    private static String clean(String value) {
        String text = value.replaceAll("<[^>]+>", " ")
                .replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
                .replaceAll("\\s+", " ").trim();
        return text.isEmpty() ? null : text;
    }

    private static String trim(String value, int max) {
        if (value == null) return null;
        return value.length() <= max ? value : value.substring(0, max);
    }

    private static boolean isPrivateHost(String host) {
        String lower = host.toLowerCase(Locale.ROOT);
        if (lower.equals("localhost") || lower.endsWith(".local")) return true;
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (address.isAnyLocalAddress() || address.isLoopbackAddress()
                        || address.isLinkLocalAddress() || address.isSiteLocalAddress()
                        || address.isMulticastAddress()) {
                    return true;
                }
            }
        } catch (Exception ex) {
            return true;
        }
        return false;
    }
}
