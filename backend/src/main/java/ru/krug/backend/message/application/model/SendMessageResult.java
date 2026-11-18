package ru.krug.backend.message.application.model;

import ru.krug.backend.message.domain.model.Message;

/**
 * Send result: HTTP status, the message view and whether the request replayed an existing
 * message. E2EE responses carry a coverage object; managed responses never do.
 */
public record SendMessageResult(int status, MessageView message, boolean replay,
                                EnvelopeCoverageView coverage) {

    public SendMessageResult(int status, MessageView message, boolean replay) {
        this(status, message, replay, null);
    }
}
