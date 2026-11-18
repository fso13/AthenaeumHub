package ru.krug.backend.auth.infrastructure.keycloak;

import java.util.Map;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;

/**
 * Keycloak token endpoint adapter for the public {@code krug-web} client. Tokens are held
 * only in the returned value and are never logged or persisted.
 */
@Component
public class KeycloakTokenExchangeAdapter implements TokenExchangePort {

    private final KeycloakHttp http;
    private final AuthBffProperties properties;

    public KeycloakTokenExchangeAdapter(KeycloakHttp http, AuthBffProperties properties) {
        this.http = http;
        this.properties = properties;
    }

    @Override
    public TokenSet passwordGrant(String email, String password) {
        MultiValueMap<String, String> form = baseForm("password");
        form.add("username", email);
        form.add("password", password);
        return grant(form);
    }

    @Override
    public TokenSet refresh(String refreshToken) {
        MultiValueMap<String, String> form = baseForm("refresh_token");
        form.add("refresh_token", refreshToken);
        return grant(form);
    }

    @Override
    public void revoke(String refreshToken) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("client_id", properties.keycloak().clientId());
        form.add("refresh_token", refreshToken);
        try {
            http.restClient().post()
                    .uri(http.endpoints().logoutUrl())
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 200 || status == 204 || status == 400 || status == 401) {
                            return null;
                        }
                        throw new ProviderUnavailableException();
                    });
        } catch (ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    @Override
    public KeycloakIdentity userInfo(String accessToken) {
        try {
            return http.restClient().get()
                    .uri(http.endpoints().userInfoUrl())
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + accessToken)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 401 || status == 403) {
                            throw new InvalidGrantException();
                        }
                        if (status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        Map<String, Object> body = http.readMap(response.getBody());
                        String givenName = KeycloakHttp.stringValue(body.get("given_name"));
                        String familyName = KeycloakHttp.stringValue(body.get("family_name"));
                        String bffDisplayName = givenName != null
                                && givenName.equals(familyName) ? givenName : null;
                        return new KeycloakIdentity(
                                KeycloakHttp.stringValue(body.get("sub")),
                                KeycloakHttp.stringValue(body.get("email")),
                                KeycloakHttp.booleanValue(body.get("email_verified")),
                                KeycloakHttp.stringValue(body.get("preferred_username")),
                                bffDisplayName != null ? bffDisplayName
                                        : KeycloakHttp.stringValue(body.get("name")));
                    });
        } catch (InvalidGrantException | ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    private TokenSet grant(MultiValueMap<String, String> form) {
        try {
            return http.restClient().post()
                    .uri(http.endpoints().tokenUrl())
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .exchange((request, response) -> {
                        int status = response.getStatusCode().value();
                        if (status == 400 || status == 401) {
                            throw new InvalidGrantException();
                        }
                        if (status != 200) {
                            throw new ProviderUnavailableException();
                        }
                        Map<String, Object> body = http.readMap(response.getBody());
                        String accessToken = KeycloakHttp.stringValue(body.get("access_token"));
                        String refreshToken = KeycloakHttp.stringValue(body.get("refresh_token"));
                        if (accessToken == null || refreshToken == null) {
                            throw new ProviderUnavailableException();
                        }
                        return new TokenSet(accessToken, refreshToken,
                                KeycloakHttp.longValue(body.get("expires_in"), 900),
                                KeycloakHttp.stringValue(body.get("token_type")));
                    });
        } catch (InvalidGrantException | ProviderUnavailableException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ProviderUnavailableException();
        }
    }

    private MultiValueMap<String, String> baseForm(String grantType) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", grantType);
        form.add("client_id", properties.keycloak().clientId());
        form.add("scope", "openid profile email");
        return form;
    }
}
