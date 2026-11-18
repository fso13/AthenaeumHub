package ru.krug.backend.message.application.usecase;

import java.time.YearMonth;
import java.time.ZoneOffset;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.message.application.port.MessagePartitionPort;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Application transaction for partition maintenance. The DDL itself is an infrastructure
 * adapter; the transaction boundary belongs here.
 */
@Service
public class MessagePartitionHandler {

    private final MessagePartitionPort partitionPort;
    private final ClockPort clock;

    public MessagePartitionHandler(MessagePartitionPort partitionPort, ClockPort clock) {
        this.partitionPort = partitionPort;
        this.clock = clock;
    }

    @Transactional
    public void ensureUpcoming(int futureMonths) {
        YearMonth current = YearMonth.from(clock.now().atZone(ZoneOffset.UTC));
        for (int offset = 0; offset <= futureMonths; offset++) {
            partitionPort.ensureMonth(current.plusMonths(offset));
        }
    }
}
