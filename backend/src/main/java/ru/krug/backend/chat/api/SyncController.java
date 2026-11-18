package ru.krug.backend.chat.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.chat.api.dto.SyncResponse;
import ru.krug.backend.chat.api.mapper.ChatApiMapper;
import ru.krug.backend.chat.application.usecase.ChatQueryService;
import ru.krug.backend.shared.application.model.Principal;

@RestController
@RequestMapping("/api/v1")
public class SyncController {

    private final ChatQueryService chatQueryService;

    public SyncController(ChatQueryService chatQueryService) {
        this.chatQueryService = chatQueryService;
    }

    @GetMapping("/sync")
    public SyncResponse sync(@RequestParam("workspace_id") UUID workspaceId, Principal principal) {
        return ChatApiMapper.toResponse(chatQueryService.sync(principal, workspaceId));
    }
}
