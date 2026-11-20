/**
 * D1.2 (#86): build the inert document that runs inside the sandboxed plugin
 * frame.
 *
 * The browser cannot attach the bearer JWT to an iframe navigation, so the host
 * fetches the entry HTML and every same-package relative asset itself and
 * inlines them into a `srcdoc` document. The package HTML is parsed with
 * `DOMParser` (inert: scripts never run, no resource is fetched by the parser),
 * then a restrictive CSP is prepended and only same-package references are
 * inlined. Absolute, protocol-relative and escaping references are dropped.
 */
import { parsePluginAssetUrl, resolvePluginAssetPath, resolveRelativeAssetPath } from './assets';
import { readBlobArrayBuffer, readBlobText } from './blob';

/** The only sandbox tokens the plugin frame ever receives. */
export const PLUGIN_FRAME_SANDBOX = 'allow-scripts';

/** Defense in depth for the srcdoc document (the host CSP still applies). */
export const PLUGIN_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024;
const MAX_INLINE_ASSETS = 64;
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export type PluginDocumentErrorCode =
  'DOCUMENT_TOO_LARGE' | 'TOO_MANY_ASSETS' | 'ASSET_BUDGET_EXCEEDED';

export class PluginDocumentError extends Error {
  readonly code: PluginDocumentErrorCode;

  constructor(code: PluginDocumentErrorCode) {
    super(code);
    this.name = 'PluginDocumentError';
    this.code = code;
  }
}

export type PluginAssetLoader = (assetPath: string) => Promise<Blob>;

export interface BuildPluginDocumentOptions {
  html: string;
  entryUrl: string;
  loadAsset: PluginAssetLoader;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('FileReader did not return a data URL'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await readBlobArrayBuffer(blob));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function safeDecodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Replace relative `url(...)` references inside a stylesheet with data URLs.
 * CSS is fetched with the bearer token by the host, so the sandboxed document
 * never needs network access.
 */
async function inlineCssUrls(
  css: string,
  cssPath: string,
  load: PluginAssetLoader,
): Promise<string> {
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const references = Array.from(css.matchAll(pattern));
  let result = css;
  for (const match of references) {
    const reference = match[2]?.trim() ?? '';
    if (!reference || /^(?:data:|blob:|#|about:)/i.test(reference)) continue;
    const resolved = resolveRelativeAssetPath(cssPath, safeDecodePath(reference));
    if (!resolved) continue;
    try {
      const blob = await load(resolved);
      const dataUrl = await blobToDataUrl(blob);
      result = result.split(match[0]).join(`url("${dataUrl}")`);
    } catch {
      // Leave the reference in place; the CSP blocks the network fallback.
    }
  }
  return result;
}

/**
 * Build the final srcdoc. Throws `PluginDocumentError` when the entry document
 * itself or its inlined payload exceeds the client budget.
 */
export async function buildPluginDocument({
  html,
  entryUrl,
  loadAsset,
}: BuildPluginDocumentOptions): Promise<string> {
  if (html.length > MAX_DOCUMENT_CHARS) throw new PluginDocumentError('DOCUMENT_TOO_LARGE');

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    throw new PluginDocumentError('DOCUMENT_TOO_LARGE');
  }

  let assetCount = 0;
  let assetBytes = 0;
  const load = async (path: string): Promise<Blob> => {
    if (assetCount >= MAX_INLINE_ASSETS) throw new PluginDocumentError('TOO_MANY_ASSETS');
    const blob = await loadAsset(path);
    assetBytes += blob.size;
    if (assetBytes > MAX_INLINE_BYTES) throw new PluginDocumentError('ASSET_BUDGET_EXCEEDED');
    assetCount += 1;
    return blob;
  };

  // A package cannot choose a different base or reload the frame on a timer.
  doc.querySelectorAll('base').forEach((element) => element.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((element) => {
    if ((element.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh') element.remove();
  });

  // Links must not navigate the frame to the network: keep only fragments.
  doc.querySelectorAll('a[href]').forEach((element) => {
    const href = element.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
    }
  });

  const references = Array.from(
    doc.querySelectorAll<HTMLElement>(
      'script[src], link[rel~="stylesheet"][href], img[src], source[src], video[poster]',
    ),
  );

  for (const element of references) {
    const tag = element.tagName.toLowerCase();
    const attribute =
      tag === 'script' ? 'src' : tag === 'link' ? 'href' : tag === 'video' ? 'poster' : 'src';
    const reference = element.getAttribute(attribute);
    if (!reference) continue;
    const resolved = resolvePluginAssetPath(entryUrl, safeDecodePath(reference));
    if (!resolved) {
      element.removeAttribute(attribute);
      continue;
    }

    try {
      const blob = await load(resolved);
      if (tag === 'script' || tag === 'link') {
        const text = await readBlobText(blob);
        if (tag === 'script') {
          const replacement = doc.createElement('script');
          const type = element.getAttribute('type');
          if (type) replacement.setAttribute('type', type);
          replacement.textContent = text;
          element.replaceWith(replacement);
        } else {
          const style = doc.createElement('style');
          style.textContent = await inlineCssUrls(text, resolved, load);
          element.replaceWith(style);
        }
      } else {
        element.setAttribute(attribute, await blobToDataUrl(blob));
        element.removeAttribute('integrity');
        element.removeAttribute('crossorigin');
      }
    } catch (error) {
      if (error instanceof PluginDocumentError) throw error;
      // Missing asset: remove the reference instead of letting the sandbox
      // attempt a network fetch that the CSP would reject anyway.
      if (tag === 'script' || tag === 'link') element.remove();
      else element.removeAttribute(attribute);
    }
  }

  // Inline `url(...)` references of package <style> blocks as well.
  const entryAssetPath = parsePluginAssetUrl(entryUrl)?.assetPath ?? '';
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = await inlineCssUrls(style.textContent ?? '', entryAssetPath, load);
  }

  const head = doc.head ?? doc.createElement('head');
  if (!doc.head) doc.documentElement.prepend(head);
  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);
  }
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', PLUGIN_DOCUMENT_CSP);
  head.prepend(csp);

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
