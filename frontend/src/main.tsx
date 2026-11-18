import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiClient } from './api/http';
import { createApi } from './api/endpoints';
import { createE2eeDeviceApi } from './api/e2eeDeviceApi';
import { getAccessToken, getDeviceId } from './auth/session';
import { configureAuthRuntime } from './auth/runtime';
import { defaultConfig } from './config/env';
import { createChatStore } from './store/chatStore';
import type { SocketFactory } from './realtime/socket';
import './styles/app.css';

async function start(): Promise<void> {
  configureAuthRuntime({ mode: defaultConfig.authMode });

  let socketFactory: SocketFactory | undefined;
  if (defaultConfig.useMocks) {
    const { startMockWorker, mockDb } = await import('./mocks/browser');
    await startMockWorker();
    const { createMockRealtimeSocketFactory } = await import('./mocks/realtime');
    socketFactory = createMockRealtimeSocketFactory(mockDb);
  }

  const client = new ApiClient({
    baseUrl: defaultConfig.apiBaseUrl,
    timeoutMs: defaultConfig.requestTimeoutMs,
    getToken: getAccessToken,
    getDeviceId,
  });

  const store = createChatStore({
    api: createApi(client, defaultConfig),
    config: defaultConfig,
    socketFactory,
    e2eeDevice: createE2eeDeviceApi(client),
  });

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element #root is missing');

  createRoot(rootElement).render(
    <StrictMode>
      <App store={store} config={defaultConfig} />
    </StrictMode>,
  );
}

void start();
