package ru.krug.backend.auth.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.MeResponse;
import ru.krug.backend.auth.api.mapper.AuthApiMapper;
import ru.krug.backend.auth.application.usecase.MeQueryService;
import ru.krug.backend.shared.application.model.Principal;

@RestController
@RequestMapping("/api/v1")
public class MeController {

    private final MeQueryService meQueryService;

    public MeController(MeQueryService meQueryService) {
        this.meQueryService = meQueryService;
    }

    @GetMapping("/me")
    public MeResponse me(Principal principal) {
        return AuthApiMapper.toResponse(meQueryService.me(principal));
    }
}
