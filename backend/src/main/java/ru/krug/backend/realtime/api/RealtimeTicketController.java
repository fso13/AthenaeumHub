package ru.krug.backend.realtime.api;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.realtime.api.dto.RealtimeTicketResponse;
import ru.krug.backend.realtime.api.mapper.RealtimeTicketApiMapper;
import ru.krug.backend.realtime.application.usecase.IssueTicketUseCase;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Issues a one-time WS ticket. The access token stays in the Authorization header; it is
 * never put into the WS URL. X-Device-Id is validated against the auth device registry by
 * the use case (foreign device -> 403).
 */
@RestController
@RequestMapping("/api/v1")
public class RealtimeTicketController {

    private final IssueTicketUseCase issueTicketUseCase;

    public RealtimeTicketController(IssueTicketUseCase issueTicketUseCase) {
        this.issueTicketUseCase = issueTicketUseCase;
    }

    @PostMapping("/realtime/ticket")
    public RealtimeTicketResponse ticket(
            @RequestHeader(value = "X-Device-Id", required = false) String deviceId,
            Principal principal) {
        return RealtimeTicketApiMapper.toResponse(issueTicketUseCase.issue(principal, deviceId));
    }
}
