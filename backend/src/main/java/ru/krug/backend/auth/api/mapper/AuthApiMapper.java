package ru.krug.backend.auth.api.mapper;

import java.util.List;

import ru.krug.backend.auth.api.dto.ChatKeysResponse;
import ru.krug.backend.auth.api.dto.DeviceKeyInfoResponse;
import ru.krug.backend.auth.api.dto.DeviceListResponse;
import ru.krug.backend.auth.api.dto.DeviceResponse;
import ru.krug.backend.auth.api.dto.KeyClaimResponse;
import ru.krug.backend.auth.api.dto.MeResponse;
import ru.krug.backend.auth.api.dto.OneTimePrekeyRequest;
import ru.krug.backend.auth.api.dto.PrekeyBundleResponse;
import ru.krug.backend.auth.api.dto.PrekeyUploadResultResponse;
import ru.krug.backend.auth.api.dto.SignedPrekeyResponse;
import ru.krug.backend.auth.api.dto.UnavailableDeviceResponse;
import ru.krug.backend.auth.api.dto.VerificationResponse;
import ru.krug.backend.auth.application.model.ChatKeysView;
import ru.krug.backend.auth.application.model.DeviceKeyInfoView;
import ru.krug.backend.auth.application.model.DeviceView;
import ru.krug.backend.auth.application.model.KeyClaimView;
import ru.krug.backend.auth.application.model.MeView;
import ru.krug.backend.auth.application.model.OneTimePrekeyView;
import ru.krug.backend.auth.application.model.PrekeyBundleView;
import ru.krug.backend.auth.application.model.PrekeyUploadView;
import ru.krug.backend.auth.application.model.SignedPrekeyView;
import ru.krug.backend.auth.application.model.VerificationView;
import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;

public final class AuthApiMapper {

    private AuthApiMapper() {
    }

    public static MeResponse toResponse(MeView view) {
        MeResponse.User user = new MeResponse.User(view.userId(), view.displayName(),
                view.email(), view.platformAdmin());
        List<MeResponse.Workspace> workspaces = view.workspaces().stream()
                .map(AuthApiMapper::toWorkspace)
                .toList();
        return new MeResponse(user, workspaces, view.defaultWorkspaceId());
    }

    public static DeviceResponse toResponse(DeviceView view) {
        return new DeviceResponse(view.id(), view.name(), view.platform(), view.status(),
                view.e2eeCapable(), view.keyGeneration(), view.identitySigningKey(),
                view.identityDhKey(), view.identityBindingSignature(), view.identityKeyAlg(),
                view.fingerprint(), toResponse(view.signedPrekey()),
                view.oneTimePrekeysAvailable(), view.createdAt(), view.lastSeenAt());
    }

    public static DeviceListResponse toListResponse(List<DeviceView> views) {
        return new DeviceListResponse(views.stream().map(AuthApiMapper::toResponse).toList());
    }

    public static PrekeyUploadResultResponse toResponse(PrekeyUploadView view) {
        return new PrekeyUploadResultResponse(view.deviceId(), view.keyGeneration(),
                view.signedPrekeyId(), view.signedPrekeyExpiresAt(),
                view.oneTimePrekeysStored(), view.oneTimePrekeysAvailable(),
                view.oneTimePrekeysLimit());
    }

    public static KeyClaimResponse toResponse(KeyClaimView view) {
        List<PrekeyBundleResponse> bundles = view.bundles().stream()
                .map(AuthApiMapper::toResponse)
                .toList();
        List<UnavailableDeviceResponse> unavailable = view.unavailable().stream()
                .map(item -> new UnavailableDeviceResponse(item.deviceId(), item.reason()))
                .toList();
        return new KeyClaimResponse(bundles, unavailable);
    }

    public static ChatKeysResponse toResponse(ChatKeysView view) {
        List<DeviceKeyInfoResponse> devices = view.devices().stream()
                .map(AuthApiMapper::toResponse)
                .toList();
        return new ChatKeysResponse(view.chatId(), view.securityMode(), view.keyEpoch(),
                view.myDeviceId(), view.verifierDeviceId(), view.verifiedCount(),
                view.verifiedByOtherDevicesCount(), view.devicesTotal(), devices);
    }

    public static VerificationResponse toResponse(VerificationView view) {
        return new VerificationResponse(view.chatId(), view.verifierDeviceId(), view.deviceId(),
                view.keyGeneration(), view.verified(), view.verifiedAt(), view.method());
    }

    private static SignedPrekeyResponse toResponse(SignedPrekeyView view) {
        if (view == null) {
            return null;
        }
        return new SignedPrekeyResponse(view.keyId(), view.publicKey(), view.signature(),
                view.createdAt(), view.expiresAt());
    }

    private static PrekeyBundleResponse toResponse(PrekeyBundleView view) {
        OneTimePrekeyView opk = view.oneTimePrekey();
        return new PrekeyBundleResponse(view.userId(), view.deviceId(), view.keyGeneration(),
                view.identitySigningKey(), view.identityDhKey(),
                view.identityBindingSignature(), view.identityKeyAlg(),
                toResponse(view.signedPrekey()),
                opk == null ? null : new OneTimePrekeyRequest(opk.keyId(), opk.publicKey()),
                view.otpExhausted());
    }

    private static DeviceKeyInfoResponse toResponse(DeviceKeyInfoView view) {
        return new DeviceKeyInfoResponse(view.deviceId(), view.userId(), view.platform(),
                view.status(), view.identitySigningKey(), view.identityDhKey(),
                view.identityBindingSignature(), view.identityKeyAlg(), view.fingerprint(),
                view.keyGeneration(), view.signedPrekeyId(), view.self(), view.verified(),
                view.verifiedAt(), view.verificationMethod(), view.lastSeenAt());
    }

    private static MeResponse.Workspace toWorkspace(WorkspaceMembershipView view) {
        return new MeResponse.Workspace(view.id(), view.name(), view.slug(), view.role(),
                view.securityMode());
    }
}
