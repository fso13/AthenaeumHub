package ru.krug.backend.bot.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotDeliveryView;
import ru.krug.backend.bot.domain.repository.BotEventRepository;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;

/** {@code GET /workspaces/{workspaceId}/bots/{botId}/deliveries} (OWNER/ADMIN). */
@Service
public class ListBotDeliveriesService {

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final BotEventRepository deliveries;

    public ListBotDeliveriesService(BotAccessGuard access, BotRepository bots,
                                    BotEventRepository deliveries) {
        this.access = access;
        this.bots = bots;
        this.deliveries = deliveries;
    }

    @Transactional(readOnly = true)
    public List<BotDeliveryView> list(Principal principal, UUID workspaceId, UUID botId,
                                      int limit) {
        access.requireManager(principal, workspaceId);
        if (limit < 1 || limit > 100) {
            throw DomainException.badRequest("limit must be between 1 and 100",
                    Map.of("field", "limit", "max", 100));
        }
        bots.findById(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        return deliveries.findRecent(workspaceId, botId, limit).stream()
                .map(BotDeliveryView::from)
                .toList();
    }
}
