package ru.krug.backend.realtime.infrastructure.ws;

/** Close codes of WS protocol v1. */
public final class WsCloseCodes {

    public static final int NORMAL = 1000;
    public static final int POLICY_VIOLATION = 1008;
    public static final int SLOW_CONSUMER = 1013;
    public static final int TICKET_INVALID = 4401;
    public static final int FORBIDDEN = 4403;

    private WsCloseCodes() {
    }
}
