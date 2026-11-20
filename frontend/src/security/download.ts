import { defaultExportFilename } from './model';

/**
 * Save an API Blob without re-encoding it. The object URL is revoked right
 * after the synthetic click; environments without `URL.createObjectURL`
 * (jsdom in some suites) simply skip the browser download and keep the
 * in-page export notice, which is still produced from the API response.
 */
export function downloadBlob(blob: Blob, filename: string | null, format: 'csv' | 'json'): void {
  const createObjectUrl = globalThis.URL?.createObjectURL;
  if (typeof createObjectUrl !== 'function') return;

  const url = createObjectUrl.call(globalThis.URL, blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename ?? defaultExportFilename(format);
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // The click has already queued the download; revoke on the next tick.
    setTimeout(() => {
      try {
        globalThis.URL.revokeObjectURL(url);
      } catch {
        // Already revoked by an environment shim; nothing to clean up.
      }
    }, 0);
  }
}
