package ru.krug.backend.plugin.infrastructure.adapter;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.usecase.PluginMessageService;
import ru.krug.backend.plugin.application.model.PluginMessageRef;
import ru.krug.backend.plugin.application.port.PluginMessagePort;
import ru.krug.backend.shared.application.model.Principal;

/** Plugin-side adapter over the message context's poll/task projection writer. */
@Component
public class PluginMessageAdapter implements PluginMessagePort {

    private final PluginMessageService messages;

    public PluginMessageAdapter(PluginMessageService messages) {
        this.messages = messages;
    }

    @Override
    public UUID createPollMessage(Principal principal, UUID chatId, UUID pollId) {
        return messages.createPollMessage(principal, chatId, pollId).id();
    }

    @Override
    public UUID createTaskMessage(Principal principal, UUID chatId, UUID taskId) {
        return messages.createTaskMessage(principal, chatId, taskId).id();
    }

    @Override
    public Optional<PluginMessageRef> findMessage(Principal principal, UUID messageId) {
        return messages.find(principal, messageId)
                .map(this::toRef);
    }

    private PluginMessageRef toRef(MessageView view) {
        return new PluginMessageRef(view.id(), view.chatId(),
                view.pluginContent() == null ? null : view.pluginContent().pollId(),
                view.pluginContent() == null ? null : view.pluginContent().taskId());
    }
}
