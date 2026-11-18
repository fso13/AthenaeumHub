package ru.krug.backend.shared.application.port;

/**
 * Feature flag {@code krug.e2ee.enabled} (default false). Gates E2EE workspace/chat
 * creation and E2EE message operations; device key registration/prekeys/claim are
 * onboarding primitives and remain available with the flag off.
 */
public interface E2eeSettingsPort {

    boolean enabled();
}
