package ru.krug.backend.message.application.usecase;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.message.application.command.SearchMessagesQuery;
import ru.krug.backend.message.application.model.MessageSearchCriteria;
import ru.krug.backend.message.application.model.MessageSearchCursor;
import ru.krug.backend.message.application.model.MessageSearchHitView;
import ru.krug.backend.message.application.model.MessageSearchPageView;
import ru.krug.backend.message.application.model.MessageSearchRow;
import ru.krug.backend.message.application.model.SearchHighlightView;
import ru.krug.backend.message.application.port.MessageSearchPort;
import ru.krug.backend.message.domain.service.SearchSnippet;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Server-side managed-message search (#83).
 *
 * <p>Tenant rules:
 * <ul>
 *   <li>the caller must be an ACTIVE workspace member ({@code 403} otherwise, existence not
 *       disclosed);</li>
 *   <li>with {@code chat_id} the caller must additionally be an ACTIVE participant of that
 *       chat ({@code 404} for a foreign/unknown chat);</li>
 *   <li>the SQL candidate query independently requires ACTIVE membership of every returned
 *       chat, so no cross-chat content can leak even without a chat filter;</li>
 *   <li>E2EE chats/messages, deleted chats/messages and delete-for-me rows are excluded in
 *       SQL and never decrypted here.</li>
 * </ul>
 *
 * <p>Because managed bodies are AES-GCM at rest, matching is done in-process over a bounded
 * keyset window of candidates. The cursor advances on the last scanned candidate, so a window
 * with no hit still progresses instead of looping. {@code has_more} is true only when the
 * window was full.
 */
@Service
public class SearchMessagesService {

    static final int DEFAULT_LIMIT = 20;
    static final int MAX_LIMIT = 50;
    private static final int MAX_QUERY_LENGTH = SearchSnippet.MAX_QUERY_LENGTH;
    private static final int MIN_SCAN = 100;
    private static final int MAX_SCAN = 500;
    private static final int SCAN_PER_HIT = 10;

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatAccessPort chatAccess;
    private final MessageSearchPort searchPort;

    public SearchMessagesService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                                 ChatAccessPort chatAccess, MessageSearchPort searchPort) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatAccess = chatAccess;
        this.searchPort = searchPort;
    }

    @Transactional(readOnly = true)
    public MessageSearchPageView search(SearchMessagesQuery query) {
        UUID workspaceId = query.workspaceId();
        if (workspaceId == null) {
            throw DomainException.badRequest("workspace_id is required",
                    Map.of("field", "workspace_id"));
        }
        String text = requireQuery(query.q());
        String normalized = text.toLowerCase(Locale.ROOT);
        Instant from = instant(query.from(), "from");
        Instant to = instant(query.to(), "to");
        if (from != null && to != null && !from.isBefore(to)) {
            throw DomainException.badRequest("from must be before to",
                    Map.of("field", "from"));
        }
        int limit = limit(query.limit());

        Principal principal = query.principal().withWorkspace(workspaceId);
        tenantContext.activate(principal);
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());
        if (query.chatId() != null) {
            chatAccess.requireActiveChat(workspaceId, query.chatId(), principal.userId());
        }

        MessageSearchCursor cursor = query.cursor() == null ? null
                : MessageSearchCursor.decode(query.cursor(), workspaceId, normalized,
                        query.chatId());
        int fetchLimit = Math.min(MAX_SCAN, Math.max(MIN_SCAN, limit * SCAN_PER_HIT));
        List<MessageSearchRow> candidates = searchPort.findCandidates(
                new MessageSearchCriteria(workspaceId, principal.userId(), query.chatId(), from,
                        to, cursor == null ? null : cursor.createdAt(),
                        cursor == null ? null : cursor.id(), fetchLimit));

        List<MessageSearchHitView> hits = new java.util.ArrayList<>(limit);
        MessageSearchRow lastScanned = null;
        int processed = 0;
        for (MessageSearchRow candidate : candidates) {
            processed++;
            lastScanned = candidate;
            SearchSnippet.Result snippet = SearchSnippet.build(candidate.text(), text,
                    SearchSnippet.MAX_SNIPPET_LENGTH);
            if (snippet == null) {
                continue;
            }
            hits.add(new MessageSearchHitView(candidate.messageId(), candidate.chatId(),
                    candidate.chatName(), candidate.seq(), candidate.senderId(),
                    candidate.senderDisplayName(), snippet.text(),
                    snippet.highlights().stream()
                            .map(range -> new SearchHighlightView(range.start(), range.end()))
                            .toList(),
                    candidate.createdAt()));
            if (hits.size() >= limit) {
                break;
            }
        }

        // Two independent reasons to continue: the hit budget was filled before the window
        // was exhausted, or the window itself was full (there may be more candidates).
        boolean hasMore = processed < candidates.size() || candidates.size() >= fetchLimit;
        String nextCursor = null;
        if (hasMore && lastScanned != null) {
            nextCursor = new MessageSearchCursor(workspaceId, normalized, query.chatId(),
                    lastScanned.createdAt(), lastScanned.messageId()).encode();
        }
        return new MessageSearchPageView(hits, nextCursor, hasMore, candidates.size());
    }

    private static String requireQuery(String value) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest("q is required", Map.of("field", "q"));
        }
        String trimmed = value.strip();
        if (trimmed.length() > MAX_QUERY_LENGTH) {
            throw DomainException.badRequest("q is too long",
                    Map.of("field", "q", "limit", MAX_QUERY_LENGTH));
        }
        return trimmed;
    }

    private static Instant instant(String value, String field) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value.strip());
        } catch (DateTimeParseException ex) {
            throw DomainException.badRequest(field + " must be an ISO-8601 instant",
                    Map.of("field", field));
        }
    }

    private static int limit(Integer value) {
        if (value == null) {
            return DEFAULT_LIMIT;
        }
        if (value < 1 || value > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and " + MAX_LIMIT,
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return value;
    }
}
