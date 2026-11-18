/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_USE_MOCKS?: string;
  readonly VITE_DEV_SESSION?: string;
  readonly VITE_API_PROXY_TARGET?: string;
  /** `dev` (F-01 /dev/session) or `password` (Auth BFF forms). */
  readonly VITE_AUTH_MODE?: 'dev' | 'password';
  readonly VITE_DEVICE_NAME?: string;
  readonly VITE_APP_VERSION?: string;
  /** E7-F5: opt-in E2EE wire-up; defaults to false. */
  readonly VITE_E2EE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
