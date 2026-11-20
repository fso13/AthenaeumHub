package ru.krug.backend.message.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.message.api.dto.MarkMentionsReadRequest;
import ru.krug.backend.message.api.dto.MentionPageResponse;
import ru.krug.backend.message.api.mapper.MentionApiMapper;
import ru.krug.backend.message.application.usecase.MentionInboxService;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code GET /me/mentions} and {@code POST /me/mentions/read} (#83). Workspace-scoped like the
 * rest of the API: the claim is used when present, otherwise the first ACTIVE workspace; an
 * explicit {@code workspace_id} overrides both. Every row belongs to the caller.
 */
@RestController
@RequestMapping("/api/v1/me/mentions")
public class MeMentionsController {

    private final MentionInboxService inboxService;

    public MeMentionsController(MentionInboxService inboxService) {
        this.inboxService = inboxService;
    }

    @GetMapping
    public MentionPageResponse list(
            @RequestParam(value = "workspace_id", required = false) UUID workspaceId,
            @RequestParam(value = "unread", required = false) Boolean unread,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return MentionApiMapper.toResponse(inboxService.list(principal, workspaceId,
                Boolean.TRUE.equals(unread), cursor, limit));
    }

    @PostMapping("/read")
    public ResponseEntity<Void> markRead(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestParam(value = "workspace_id", required = false) UUID workspaceId,
            @RequestBody(required = false) MarkMentionsReadRequest request,
            Principal principal) {
        RequestHeaders.requireUuid(idempotencyKey, "Idempotency-Key");
        if (request == null) {
            throw DomainException.badRequest("Request body is required",
                    java.util.Map.of("reason", "missing_body"));
        }
        inboxService.markRead(principal, workspaceId, request.ids(),
                Boolean.TRUE.equals(request.all()));
        return ResponseEntity.noContent().build();
    }
}
