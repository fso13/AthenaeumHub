package ru.krug.backend.message.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.message.api.dto.MessageSearchPageResponse;
import ru.krug.backend.message.api.mapper.MessageSearchApiMapper;
import ru.krug.backend.message.application.command.SearchMessagesQuery;
import ru.krug.backend.message.application.usecase.SearchMessagesService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /workspaces/{workspaceId}/search/messages} (#83) — server-side managed message
 * search. Returns plain-text snippets with highlight ranges; E2EE chats are never searched.
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/search")
public class MessageSearchController {

    private final SearchMessagesService searchService;

    public MessageSearchController(SearchMessagesService searchService) {
        this.searchService = searchService;
    }

    @GetMapping("/messages")
    public MessageSearchPageResponse search(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "chat_id", required = false) UUID chatId,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return MessageSearchApiMapper.toResponse(searchService.search(new SearchMessagesQuery(
                principal, workspaceId, q, chatId, from, to, cursor, limit)), q == null ? null
                : q.strip());
    }
}
