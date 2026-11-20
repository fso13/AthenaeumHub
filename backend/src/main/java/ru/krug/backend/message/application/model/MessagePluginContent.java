package ru.krug.backend.message.application.model;

import java.util.UUID;

/**
 * Plugin projection of a POLL/TASK message: the ids are part of the message row, the
 * embedded objects are resolved per viewer at read time. {@code poll}/{@code task} are null
 * for tombstones and when the referenced row is unavailable.
 */
public record MessagePluginContent(UUID pollId, EmbeddedPollView poll, UUID taskId,
                                   EmbeddedTaskView task) {

    public static MessagePluginContent ids(UUID pollId, UUID taskId) {
        return new MessagePluginContent(pollId, null, taskId, null);
    }

    public MessagePluginContent withPoll(EmbeddedPollView value) {
        return new MessagePluginContent(pollId, value, taskId, task);
    }

    public MessagePluginContent withTask(EmbeddedTaskView value) {
        return new MessagePluginContent(pollId, poll, taskId, value);
    }
}
