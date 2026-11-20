import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Plugin } from '../../api/types';
import { t } from '../../i18n/ru';
import { parsePluginAssetUrl } from '../../plugins/assets';
import {
  PLUGIN_FRAME_SANDBOX,
  PluginDocumentError,
  buildPluginDocument,
} from '../../plugins/externalDocument';
import {
  buildPluginInitMessage,
  buildPluginRpcErrorResult,
  parsePluginMessage,
} from '../../plugins/messages';
import { PLUGIN_PERMISSION_LABEL } from '../../plugins/model';
import { CloseIcon, LockIcon } from '../Icons';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ExternalPluginRunnerProps {
  plugin: Plugin;
  chatId: string | null;
  onClose: () => void;
  loadEntry: (entryUrl: string) => Promise<string>;
  loadAsset: (entryUrl: string, assetPath: string) => Promise<Blob>;
}

type RunnerPhase = 'loading' | 'ready' | 'error' | 'blocked';

function themeForPlugin(): 'light' | 'dark' {
  const value =
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  return value === 'dark' ? 'dark' : 'light';
}

function documentErrorMessage(error: unknown): string {
  if (error instanceof PluginDocumentError) {
    if (error.code === 'TOO_MANY_ASSETS' || error.code === 'ASSET_BUDGET_EXCEEDED') {
      return t('plugins.external.tooManyAssets');
    }
    return t('plugins.external.documentTooLarge');
  }
  return t('plugins.external.loadError');
}

/**
 * Full-screen sandboxed runner for one external package (D1.2 #86).
 *
 * Security invariants:
 * * the iframe always has exactly `sandbox="allow-scripts"` — never
 *   `allow-same-origin`, `allow-popups`, `allow-modals` or top navigation;
 * * the entry document is fetched with the bearer token by the host, then
 *   placed into `srcdoc`; the token never enters the iframe URL or messages;
 * * the package HTML is parsed inertly and only same-package relative assets
 *   are inlined; absolute references and external navigation are removed;
 * * `postMessage` input is schema/limit validated and checked against
 *   `event.source === iframe.contentWindow`; log text never reaches the DOM.
 */
export function ExternalPluginRunner({
  plugin,
  chatId,
  onClose,
  loadEntry,
  loadAsset,
}: ExternalPluginRunnerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const loadCount = useRef(0);
  const rateWindow = useRef({ startedAt: 0, count: 0 });
  const [phase, setPhase] = useState<RunnerPhase>('loading');
  const [html, setHtml] = useState<string>('');
  const frameUrl = useMemo(() => {
    if (!html) return '';
    return `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`;
  }, [html]);
  const [errorText, setErrorText] = useState<string>('');
  const [pluginReady, setPluginReady] = useState(false);
  const [logCount, setLogCount] = useState(0);
  const titleId = `plugin-runner-title-${plugin.id}`;
  const descriptionId = `plugin-runner-desc-${plugin.id}`;
  const entryUrl = plugin.entry_url;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setHtml('');
    setErrorText('');
    setPluginReady(false);
    setLogCount(0);
    loadCount.current = 0;

    if (!entryUrl || !parsePluginAssetUrl(entryUrl)) {
      setPhase('error');
      setErrorText(t('plugins.external.missingEntry'));
      return;
    }

    void (async () => {
      try {
        const entryHtml = await loadEntry(entryUrl);
        const documentHtml = await buildPluginDocument({
          html: entryHtml,
          entryUrl,
          loadAsset: (assetPath) => loadAsset(entryUrl, assetPath),
        });
        if (cancelled) return;
        setHtml(documentHtml);
        setPhase('ready');
      } catch (error) {
        if (cancelled) return;
        setPhase('error');
        setErrorText(documentErrorMessage(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entryUrl, loadAsset, loadEntry]);

  // Modal focus/return, scroll lock and Escape handling.
  useEffect(() => {
    const trigger = document.activeElement;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  // Minimal host side of the documented postMessage protocol.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      // The only trusted sender is the sandboxed frame of this runner.
      if (!frame || event.source !== frame.contentWindow) return;

      const now = Date.now();
      if (now - rateWindow.current.startedAt > 1_000) {
        rateWindow.current = { startedAt: now, count: 0 };
      }
      rateWindow.current.count += 1;
      if (rateWindow.current.count > 60) return;

      const message = parsePluginMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') {
        setPluginReady(true);
        return;
      }
      if (message.type === 'rpc') {
        // No RPC broker exists in this slice; never invent a result.
        frame.contentWindow?.postMessage(buildPluginRpcErrorResult(message.id), '*');
        return;
      }
      // Logs are counted at most; their text is untrusted and never rendered.
      setLogCount((count) => Math.min(count + 1, 99));
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const sendInit = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow || !entryUrl) return;
    // A second load means the package navigated the frame somewhere else.
    loadCount.current += 1;
    if (loadCount.current > 1) {
      setPhase('blocked');
      return;
    }
    frame.contentWindow.postMessage(
      buildPluginInitMessage({
        pluginId: plugin.id,
        version: plugin.version ?? '0.0.0',
        permissions: plugin.permissions,
        locale: 'ru',
        theme: themeForPlugin(),
        chatId,
      }),
      '*',
    );
  }, [chatId, entryUrl, plugin.id, plugin.permissions, plugin.version]);

  return (
    <div
      className="plugin-runner"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="plugin-runner__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="plugin-runner__bar">
          <div className="plugin-runner__identity">
            <span
              className={`admin-chip admin-chip--${plugin.kind === 'EXTERNAL' ? 'warning' : 'ok'}`}
            >
              {t('plugins.external.badge')}
            </span>
            <h2 className="plugin-runner__title" id={titleId}>
              {plugin.name}
            </h2>
            {plugin.version ? (
              <span className="plugin-runner__version">v{plugin.version}</span>
            ) : null}
            {plugin.author ? (
              <span className="plugin-runner__author">
                {t('plugins.external.author', { author: plugin.author })}
              </span>
            ) : null}
          </div>
          <div className="plugin-runner__actions">
            {pluginReady ? (
              <span className="admin-chip admin-chip--ok" role="status">
                {t('plugins.external.ready')}
              </span>
            ) : null}
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label={t('plugins.external.close')}
              title={t('plugins.external.close')}
            >
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <p className="plugin-runner__sandbox-note" id={descriptionId}>
          <LockIcon aria-hidden="true" />
          <span>
            {t('plugins.external.isolation')}
            {logCount > 0 ? ` ${t('plugins.external.logCount', { count: logCount })}` : ''}
          </span>
        </p>

        {phase === 'loading' ? (
          <div className="plugin-runner__state" role="status">
            <span className="skeleton plugin-runner__skeleton" aria-hidden="true" />
            <p>{t('plugins.external.loading')}</p>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="plugin-runner__state plugin-runner__state--error" role="alert">
            <p>{errorText || t('plugins.external.loadError')}</p>
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t('plugins.external.close')}
            </button>
          </div>
        ) : null}

        {phase === 'blocked' ? (
          <div className="plugin-runner__state plugin-runner__state--error" role="alert">
            <p>{t('plugins.external.navigationBlocked')}</p>
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t('plugins.external.close')}
            </button>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <iframe
            ref={iframeRef}
            className="plugin-runner__frame"
            title={t('plugins.external.frameTitle', { name: plugin.name })}
            sandbox={PLUGIN_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow="clipboard-write"
            src={frameUrl}
            onLoad={sendInit}
          />
        ) : null}

        <footer className="plugin-runner__foot">
          <span>
            {t('plugins.external.permissions')}:{' '}
            {plugin.permissions.length > 0
              ? plugin.permissions
                  .map((permission) => t(PLUGIN_PERMISSION_LABEL[permission]))
                  .join(', ')
              : t('plugins.external.noPermissions')}
          </span>
        </footer>
      </div>
    </div>
  );
}
