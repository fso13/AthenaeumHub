package ru.krug.backend.bot.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;

/** {@code GET /workspaces/{workspaceId}/bots}: any ACTIVE workspace member, no secrets. */
@Service
public class ListBotsService {

    private final BotAccessGuard access;
    private final BotRepository bots;

    public ListBotsService(BotAccessGuard access, BotRepository bots) {
        this.access = access;
        this.bots = bots;
    }

    @Transactional(readOnly = true)
    public List<BotView> list(Principal principal, UUID workspaceId) {
        access.requireMember(principal, workspaceId);
        return bots.findByWorkspace(workspaceId).stream().map(BotView::from).toList();
    }
}
