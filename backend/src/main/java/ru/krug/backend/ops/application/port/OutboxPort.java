package ru.krug.backend.ops.application.port;

import ru.krug.backend.ops.application.model.OutboxEvent;

public interface OutboxPort {

    void append(OutboxEvent event);
}
