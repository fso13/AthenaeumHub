import { useMemo } from 'react';
import * as QRCode from 'qrcode';
import { t } from '../i18n/ru';

export interface QrCodeProps {
  /**
   * Payload to encode. `otpauth://` URIs are expected, but any string works.
   * A `data:image/` payload is treated as a server-rendered QR image (the
   * contract's `qr_payload` may be either the URI or a data URI).
   */
  value: string;
  /** Accessible name; QR content itself is never announced (it is a secret). */
  label: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
  className?: string;
}

/** Four-module quiet zone keeps phone cameras able to lock onto the symbol. */
const QUIET_ZONE = 4;

function buildPath(value: string): { size: number; path: string } | null {
  try {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const parts: string[] = [];
    for (let row = 0; row < modules.size; row += 1) {
      for (let column = 0; column < modules.size; column += 1) {
        // BitMatrix#get(row, column) — the package stores data row-major.
        if (modules.get(row, column)) {
          parts.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
        }
      }
    }
    return { size: modules.size, path: parts.join('') };
  } catch {
    return null;
  }
}

/**
 * #93 local QR renderer for the TOTP `otpauth` URI.
 *
 * - Encoding happens entirely in the browser (`qrcode`); no external QR image
 *   service, no network request and no server-side secret round-trip.
 * - Drawn as crisp SVG modules instead of `<canvas>` so it is sharp at any DPI,
 *   works in jsdom/axe tests and never requires `canvas.getContext`.
 * - The payload is displayed only while the current setup flow is open; this
 *   component keeps no state, writes no storage and logs nothing.
 */
export function QrCode({ value, label, size = 192, className }: QrCodeProps) {
  const dataUri = /^data:image\//i.test(value) ? value : null;
  const encoded = useMemo(() => (dataUri ? null : buildPath(value)), [dataUri, value]);

  if (dataUri) {
    return (
      <img
        className={className ? `qr-code ${className}` : 'qr-code'}
        src={dataUri}
        alt={label}
        width={size}
        height={size}
      />
    );
  }

  if (!encoded) {
    return (
      <p className="qr-code__error" role="alert">
        {t('qr.error')}
      </p>
    );
  }

  const dimension = encoded.size + QUIET_ZONE * 2;
  return (
    <svg
      className={className ? `qr-code ${className}` : 'qr-code'}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-qr-modules={encoded.size}
    >
      <title>{label}</title>
      <rect width={dimension} height={dimension} rx={1.5} fill="#ffffff" />
      <path d={encoded.path} fill="#0b1a17" />
    </svg>
  );
}
