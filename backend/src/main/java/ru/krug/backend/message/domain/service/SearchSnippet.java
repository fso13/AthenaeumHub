package ru.krug.backend.message.domain.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import ru.krug.backend.message.domain.model.SearchHighlight;

/**
 * Builds a plain-text search snippet with highlight ranges (#83).
 *
 * <p>The server never returns HTML or markdown markup: the snippet is a substring of the
 * managed message text and the highlights are character ranges
 * ({@code start} inclusive, {@code end} exclusive). A client must render it as text with
 * those ranges emphasised, never interpolate it as HTML.
 *
 * <p>Matching is case-insensitive literal containment (no regex, no wildcard); the query is
 * capped at {@value #MAX_QUERY_LENGTH} characters so a pathological needle cannot make the
 * scan quadratic in a hostile way.
 */
public final class SearchSnippet {

    public static final int MAX_QUERY_LENGTH = 200;
    public static final int MAX_SNIPPET_LENGTH = 240;
    public static final String ELLIPSIS = "…";

    private SearchSnippet() {
    }

    /**
     * @param text     full plaintext of a managed message
     * @param query    already validated, non-blank literal needle
     * @param maxLength maximum snippet length; clamped to a positive bound
     * @return snippet plus highlight ranges; {@code null} when the text does not contain the
     *         query (never fabricates a hit)
     */
    public static Result build(String text, String query, int maxLength) {
        if (text == null || query == null || query.isEmpty()) {
            return null;
        }
        String needle = query.toLowerCase(Locale.ROOT);
        String haystack = text.toLowerCase(Locale.ROOT);
        int first = haystack.indexOf(needle);
        if (first < 0) {
            return null;
        }
        int limit = Math.max(1, Math.min(maxLength, MAX_SNIPPET_LENGTH));
        // Center a bounded window on the first match so the hit is always visible even when
        // the message is much longer than the snippet.
        int context = Math.max(0, (limit - needle.length()) / 2);
        int start = Math.max(0, first - context);
        int end = Math.min(text.length(), start + limit);
        if (end - start < limit) {
            start = Math.max(0, end - limit);
        }

        StringBuilder snippet = new StringBuilder();
        boolean truncatedLeft = start > 0;
        boolean truncatedRight = end < text.length();
        if (truncatedLeft) {
            snippet.append(ELLIPSIS);
        }
        snippet.append(text, start, end);
        if (truncatedRight) {
            snippet.append(ELLIPSIS);
        }
        String value = snippet.toString();

        // Locate every match of the needle inside the snippet window, case-insensitively.
        String snippetLower = value.toLowerCase(Locale.ROOT);
        List<SearchHighlight> highlights = new ArrayList<>();
        int index = snippetLower.indexOf(needle);
        while (index >= 0) {
            highlights.add(new SearchHighlight(index, index + needle.length()));
            index = snippetLower.indexOf(needle, index + Math.max(1, needle.length()));
        }
        if (highlights.isEmpty()) {
            // Defensive: the window is derived from the first match, so this cannot happen;
            // still return a valid snippet rather than an inconsistent highlight list.
            return new Result(value, List.of());
        }
        return new Result(value, List.copyOf(highlights));
    }

    /** Snippet value plus its highlight ranges. */
    public record Result(String text, List<SearchHighlight> highlights) {

        public Result {
            highlights = highlights == null ? List.of() : List.copyOf(highlights);
        }
    }
}
