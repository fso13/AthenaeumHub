package ru.krug.backend.bot.application.service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.springframework.stereotype.Component;

import ru.krug.backend.bot.application.model.BotMessageEvent;
import ru.krug.backend.bot.domain.model.BotEventType;

/**
 * Builds the JSON event envelope. It contains only data the bot is entitled to receive for
 * this event: message metadata and managed text for a message event, command metadata for a
 * slash command. No E2EE ciphertext, file bytes, tokens or secrets are ever included; the
 * response capability travels only inside the signed slash-command payload.
 */
@Component
public class BotEventEnvelope {

    private final ObjectMapper objectMapper;

    public BotEventEnvelope(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public String messageEvent(BotEventType type, BotMessageEvent event) {
        Map<String, Object> root = base(type, event.messageId(), event.createdAt(),
                event.workspaceId(), event.chatId());
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("id", event.messageId());
        message.put("chat_id", event.chatId());
        message.put("seq", event.seq());
        message.put("type", event.type());
        message.put("sender_type", event.isBotAuthored() ? "BOT" : "USER");
        message.put("sender_id", event.senderId());
        message.put("bot_id", event.senderBotId());
        message.put("sender_display_name", event.senderDisplayName());
        message.put("text", event.text());
        message.put("reply_to_id", event.replyToId());
        message.put("thread_root_id", event.threadRootId());
        message.put("created_at", event.createdAt().toString());
        root.put("message", message);
        return write(root);
    }

    public String slashCommand(UUID eventId, UUID workspaceId, UUID chatId, UUID userId,
                               String command, String args, String responseUrl,
                               Instant createdAt) {
        Map<String, Object> root = base(BotEventType.SLASH_COMMAND, eventId, createdAt,
                workspaceId, chatId);
        root.put("command", command);
        root.put("args", args == null ? "" : args);
        root.put("user_id", userId);
        root.put("response_url", responseUrl);
        return write(root);
    }

    public String test(UUID eventId, UUID workspaceId, UUID botId, Instant createdAt) {
        Map<String, Object> root = base(BotEventType.TEST, eventId, createdAt, workspaceId, null);
        root.put("bot_id", botId);
        return write(root);
    }

    private static Map<String, Object> base(BotEventType type, UUID eventId, Instant createdAt,
                                            UUID workspaceId, UUID chatId) {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("type", type.wire());
        root.put("id", eventId);
        root.put("created_at", createdAt.toString());
        root.put("workspace_id", workspaceId);
        root.put("chat_id", chatId);
        return root;
    }

    private String write(Map<String, Object> root) {
        try {
            return objectMapper.writeValueAsString(root);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Could not serialize bot event envelope", ex);
        }
    }
}
