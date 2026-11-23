package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.model.BotUpdateResult;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotSigningSecrets;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code POST /workspaces/{workspaceId}/bots/{botId}/secret} (OWNER/ADMIN). Generates a new
 * signing secret, stores only its AES-GCM ciphertext and returns the raw value exactly once.
 * The previous secret stops verifying immediately.
 */
@Service
public class RotateBotSecretService {

    static final String ACTION = "bot.secret.rotated";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final BotSecretCipherPort secretCipher;
    private final AuditPort audit;
    private final ClockPort clock;

    public RotateBotSecretService(BotAccessGuard access, BotRepository bots,
                                  BotSecretCipherPort secretCipher, AuditPort audit,
                                  ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.secretCipher = secretCipher;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public BotUpdateResult rotate(Principal principal, UUID workspaceId, UUID botId) {
        access.requireManager(principal, workspaceId);
        Bot bot = bots.findByIdForUpdate(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        Instant now = clock.now();
        String rawSecret = BotSigningSecrets.newSecret();
        Bot rotated = bot.rotateSigningSecret(
                secretCipher.encryptSecret(rawSecret, bot.id()), now);
        bots.save(rotated);
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                principal.requestId(), Map.of(), now));
        return new BotUpdateResult(BotView.from(rotated, rawSecret), rawSecret);
    }
}
