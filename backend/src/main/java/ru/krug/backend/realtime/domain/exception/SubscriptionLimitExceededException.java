package ru.krug.backend.realtime.domain.exception;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** More than the configured number of chats requested on one connection. */
public class SubscriptionLimitExceededException extends DomainException {

    public SubscriptionLimitExceededException(int limit) {
        super(ErrorCategory.BAD_REQUEST, ErrorCode.SUBSCRIPTION_LIMIT,
                "Subscription limit exceeded", Map.of("max_subscriptions", limit), null);
    }
}
