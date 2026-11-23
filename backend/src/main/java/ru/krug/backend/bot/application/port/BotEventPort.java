package ru.krug.backend.bot.application.port;

import ru.krug.backend.bot.application.model.BotMessageEvent;

/**
 * Message -> bot event bridge. The implementation appends durable delivery rows in the
 * message transaction; the HTTP call itself happens later, after commit, in the worker.
 */
public interface BotEventPort {

    void onMessageCreated(BotMessageEvent event);
}
