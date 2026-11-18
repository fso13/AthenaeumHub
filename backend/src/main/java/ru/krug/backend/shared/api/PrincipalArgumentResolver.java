package ru.krug.backend.shared.api;

import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.core.MethodParameter;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import ru.krug.backend.shared.application.model.AuthenticatedActor;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Builds the application Principal from the actor resolved by DeviceBindingFilter. The
 * workspace claim is dev-only; Keycloak principals bind the workspace from the resource.
 */
@Component
public class PrincipalArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return Principal.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (!(authentication instanceof JwtAuthenticationToken token)) {
            throw new IllegalStateException("Principal requested on an unauthenticated request");
        }
        HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);
        if (request == null) {
            throw new IllegalStateException("No HTTP request available");
        }
        Object attribute = request.getAttribute(AuthenticatedActor.REQUEST_ATTRIBUTE);
        if (!(attribute instanceof AuthenticatedActor actor)) {
            throw new IllegalStateException("Authenticated actor was not resolved");
        }
        Jwt jwt = token.getToken();
        return new Principal(actor.userId(), actor.deviceId(), workspaceClaim(jwt),
                RequestIdFilter.requestId(request));
    }

    private static UUID workspaceClaim(Jwt jwt) {
        String value = jwt.getClaimAsString("workspace_id");
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
