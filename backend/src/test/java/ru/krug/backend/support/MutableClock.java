package ru.krug.backend.support;

import java.time.Instant;

import ru.krug.backend.shared.application.port.ClockPort;

/** Adjustable clock for TOTP/attempt/cooldown tests. */
public class MutableClock implements ClockPort {

    private Instant now;

    public MutableClock(Instant now) {
        this.now = now;
    }

    @Override
    public Instant now() {
        return now;
    }

    public void set(Instant now) {
        this.now = now;
    }

    public void advanceSeconds(long seconds) {
        this.now = now.plusSeconds(seconds);
    }
}
