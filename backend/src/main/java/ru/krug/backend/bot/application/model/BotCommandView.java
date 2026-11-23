package ru.krug.backend.bot.application.model;

import java.util.List;

import ru.krug.backend.bot.domain.model.BotCommand;

/** API/read projection of a registered slash command. */
public record BotCommandView(String command, String description) {

    public static BotCommandView from(BotCommand command) {
        return new BotCommandView(command.command(), command.description());
    }

    public static List<BotCommandView> from(List<BotCommand> commands) {
        return commands == null ? List.of()
                : commands.stream().map(BotCommandView::from).toList();
    }
}
