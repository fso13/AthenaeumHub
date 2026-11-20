package ru.krug.backend.auth.api.mapper;

import ru.krug.backend.auth.api.dto.AuthRegisterResponse;
import ru.krug.backend.auth.api.dto.AuthTwoFactorChallengeResponse;
import ru.krug.backend.auth.api.dto.AuthResendEmailCodeResponse;
import ru.krug.backend.auth.api.dto.AuthSessionResponse;
import ru.krug.backend.auth.api.dto.AuthUserResponse;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.RegistrationView;
import ru.krug.backend.auth.application.model.TwoFactorChallengeView;
import ru.krug.backend.auth.application.model.ResendCodeView;

/** Auth BFF API mapping. No domain or infrastructure types cross this boundary. */
public final class AuthBffApiMapper {

    private AuthBffApiMapper() {
    }

    public static AuthRegisterResponse toResponse(RegistrationView view) {
        return new AuthRegisterResponse(view.verificationId(), view.expiresIn(),
                view.resendAfter());
    }

    public static AuthResendEmailCodeResponse toResponse(ResendCodeView view) {
        return new AuthResendEmailCodeResponse(view.expiresIn(), view.resendAfter());
    }

    public static AuthTwoFactorChallengeResponse toResponse(TwoFactorChallengeView view) {
        return new AuthTwoFactorChallengeResponse(view.challengeId(), view.expiresIn(),
                view.methods());
    }

    public static AuthSessionResponse toResponse(AuthSessionView view) {
        return new AuthSessionResponse(view.accessToken(), view.refreshToken(), view.expiresIn(),
                view.tokenType(),
                new AuthUserResponse(view.user().id(), view.user().displayName(),
                        view.user().email(), view.user().platformAdmin()));
    }
}
