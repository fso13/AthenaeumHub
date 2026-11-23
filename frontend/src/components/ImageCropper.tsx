import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CROP_MAX_OUTPUT_BYTES,
  CROP_MAX_OUTPUT_SIZE,
  clampCropPan,
  clampCropZoom,
  coverScale,
  cropFileName,
  cropOutputSize,
  drawCrop,
  nextCropRotation,
  normalizeCropRotation,
  type CropCanvasContext,
  type CropRotation,
  type CropSize,
  type CropTransform,
} from '../files/imageCrop';
import { t } from '../i18n/ru';
import { CloseIcon, RefreshIcon } from './Icons';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const STAGE_WIDTH = 260;
const PAN_STEP = 10;

export interface ImageCropResult {
  file: File;
  width: number;
  height: number;
}

export interface ImageCropperProps {
  /** The exact file the user picked; it is never mutated. */
  file: File;
  /** Crop window aspect ratio: 1 for avatars/logos, 16/9 for covers. */
  aspect?: number;
  maxOutputSize?: number;
  maxOutputBytes?: number;
  /** Render as an inline panel instead of a modal dialog. */
  inline?: boolean;
  /** Optional title override; defaults to the RU crop title. */
  title?: string;
  onApply: (result: ImageCropResult) => void | Promise<void>;
  /** "Use without cropping": upload the original bytes through the same path. */
  onUseOriginal?: (file: File) => void | Promise<void>;
  onCancel: () => void;
}

function normalizeAspect(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(4, Math.max(0.25, value));
}

function formatPx(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

function focusableInside(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('invalid-data-url');
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

/** `canvas.toBlob` with a `toDataURL` fallback for older engines/test doubles. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('empty-blob'))),
        'image/png',
      );
      return;
    }
    try {
      resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
    } catch (error) {
      reject(error);
    }
  });
}

async function renderCroppedFile(
  source: HTMLImageElement,
  imageSize: CropSize,
  viewport: CropSize,
  transform: CropTransform,
  maxOutputSize: number,
  maxOutputBytes: number,
  originalName: string,
): Promise<ImageCropResult> {
  const normalized: CropTransform = {
    zoom: clampCropZoom(transform.zoom),
    rotation: normalizeCropRotation(transform.rotation),
    ...clampCropPan(
      transform.panX,
      transform.panY,
      viewport,
      imageSize,
      transform.rotation,
      transform.zoom,
    ),
  };
  let limit = Math.max(1, Math.min(CROP_MAX_OUTPUT_SIZE, Math.round(maxOutputSize)));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const output = cropOutputSize(viewport, imageSize, normalized.rotation, normalized.zoom, limit);
    const canvas = document.createElement('canvas');
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas-unavailable');
    drawCrop(
      context as unknown as CropCanvasContext,
      source,
      imageSize,
      viewport,
      normalized,
      output,
    );
    const blob = await canvasToBlob(canvas);
    if (blob.size <= maxOutputBytes) {
      return {
        file: new File([blob], cropFileName(originalName), {
          type: 'image/png',
          lastModified: Date.now(),
        }),
        width: output.width,
        height: output.height,
      };
    }
    limit = Math.floor(limit * 0.75);
    if (limit < 64) break;
  }
  throw new Error('output-too-large');
}

/**
 * #106 reusable avatar/profile-picture cropper.
 *
 * - file preview with a square (or `aspect`) crop window;
 * - zoom 1..4×, drag/pan, arrow-key pan, 90° rotation and reset;
 * - 48 px + 96 px thumbnails and a "how it will look" preview;
 * - Apply renders the *same* framing through a 2D canvas into a PNG `File`
 *   (max 1024 px, ≤5 MiB), while "without cropping" uploads the original;
 * - the object URL is revoked on replacement/unmount, the modal traps focus and
 *   Escape cancels without also closing a parent settings dialog (capture
 *   phase).
 *
 * The server still validates magic bytes, animation, extension and size: this
 * component only prepares a better-shaped file for the existing upload path.
 */
export function ImageCropper({
  file,
  aspect: aspectProp,
  maxOutputSize = CROP_MAX_OUTPUT_SIZE,
  maxOutputBytes = CROP_MAX_OUTPUT_BYTES,
  inline = false,
  title,
  onApply,
  onUseOriginal,
  onCancel,
}: ImageCropperProps) {
  const aspect = normalizeAspect(aspectProp);
  const stage = useMemo<CropSize>(
    () => ({ width: STAGE_WIDTH, height: Math.max(1, Math.round(STAGE_WIDTH / aspect)) }),
    [aspect],
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const titleId = useId();
  const hintId = useId();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<CropSize | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ panX: 0, panY: 0 });
  const [rotation, setRotation] = useState<CropRotation>(0);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /** Closing while the PNG is being rendered would orphan the async apply. */
  const requestCancel = () => {
    if (!busyRef.current) cancelRef.current();
  };

  // Object URLs are owned by this component and revoked on every replacement.
  useEffect(() => {
    let url: string | null = null;
    if (typeof URL.createObjectURL === 'function') {
      try {
        url = URL.createObjectURL(file);
      } catch {
        url = null;
      }
    }
    setPreviewUrl(url);
    setImageSize(null);
    setLoadError(url === null);
    setErrorText(null);
    return () => {
      if (url && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    };
  }, [file]);

  // Keep the bitmap covering the window whenever zoom/rotation changes.
  useEffect(() => {
    if (!imageSize) return;
    setPan((previous) => {
      const next = clampCropPan(previous.panX, previous.panY, stage, imageSize, rotation, zoom);
      return previous.panX === next.panX && previous.panY === next.panY ? previous : next;
    });
  }, [imageSize, rotation, stage, zoom]);

  // Modal focus trap + Escape. The capture phase stops the parent settings
  // dialog from also handling Escape/Tab while the cropper is open.
  useEffect(() => {
    if (inline) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => stageRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      // The nested cropper owns Tab while it is mounted.
      event.stopPropagation();
      const focusable = focusableInside(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
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

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [inline]);

  const baseScale = imageSize ? coverScale(stage, imageSize, rotation) : 1;
  const imageStyle: CSSProperties | null = imageSize
    ? {
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: formatPx(imageSize.width * baseScale),
        height: formatPx(imageSize.height * baseScale),
        maxWidth: 'none',
        maxHeight: 'none',
        transform: `translate(-50%, -50%) translate(${formatPx(pan.panX)}, ${formatPx(pan.panY)}) rotate(${rotation}deg) scale(${zoom})`,
        transformOrigin: 'center',
        visibility: 'visible',
      }
    : { visibility: 'hidden' };

  const handleLoad = (element: HTMLImageElement) => {
    const width = element.naturalWidth || element.width;
    const height = element.naturalHeight || element.height;
    if (width > 0 && height > 0) {
      setImageSize({ width, height });
      setLoadError(false);
      setErrorText(null);
    } else {
      setLoadError(true);
    }
  };

  const movePan = (deltaX: number, deltaY: number) => {
    if (!imageSize) return;
    setPan((current) => {
      const next = clampCropPan(
        current.panX + deltaX,
        current.panY + deltaY,
        stage,
        imageSize,
        rotation,
        zoom,
      );
      return next;
    });
  };

  const handleStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? PAN_STEP * 3 : PAN_STEP;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      movePan(-step, 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      movePan(step, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePan(0, -step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePan(0, step);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !imageSize) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.panX,
      panY: pan.panY,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !imageSize) return;
    const next = clampCropPan(
      drag.panX + (event.clientX - drag.startX),
      drag.panY + (event.clientY - drag.startY),
      stage,
      imageSize,
      rotation,
      zoom,
    );
    setPan(next);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const reset = () => {
    setZoom(1);
    setPan({ panX: 0, panY: 0 });
    setRotation(0);
    setErrorText(null);
  };

  const apply = async () => {
    const source = imageRef.current;
    if (!source || !imageSize || busy) return;
    setBusy(true);
    setErrorText(null);
    try {
      const result = await renderCroppedFile(
        source,
        imageSize,
        stage,
        { zoom, panX: pan.panX, panY: pan.panY, rotation },
        Math.min(maxOutputSize, CROP_MAX_OUTPUT_SIZE),
        Math.min(maxOutputBytes, CROP_MAX_OUTPUT_BYTES),
        file.name,
      );
      await Promise.resolve(onApply(result));
    } catch {
      setErrorText(t('crop.outputError'));
    } finally {
      setBusy(false);
    }
  };

  const useOriginal = () => {
    if (!onUseOriginal) return;
    setErrorText(null);
    void Promise.resolve(onUseOriginal(file)).catch(() => {
      setErrorText(t('crop.outputError'));
    });
  };

  const radius = aspect === 1 ? '50%' : '10px';
  const canApply = imageSize !== null && !busy && !loadError;

  const body = (
    <>
      <header className="image-cropper__head">
        <div className="image-cropper__heading">
          <h2 className="image-cropper__title" id={titleId}>
            {title ?? t('crop.title')}
          </h2>
          <p className="image-cropper__hint" id={hintId}>
            {t('crop.hint')}
          </p>
        </div>
        <button
          type="button"
          className="modal-x"
          aria-label={t('crop.close')}
          disabled={busy}
          onClick={requestCancel}
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </header>

      <div className="image-cropper__body">
        <div
          ref={stageRef}
          className="image-cropper__stage"
          style={{ width: stage.width, height: stage.height }}
          role="group"
          tabIndex={0}
          aria-label={t('crop.stage')}
          aria-describedby={hintId}
          onKeyDown={handleStageKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          {previewUrl ? (
            <img
              ref={imageRef}
              className="image-cropper__image"
              src={previewUrl}
              alt={t('crop.imageAlt')}
              draggable={false}
              style={imageStyle ?? undefined}
              onLoad={(event) => handleLoad(event.currentTarget)}
              onError={() => {
                setLoadError(true);
                setImageSize(null);
              }}
            />
          ) : null}
          <div className="image-cropper__overlay" aria-hidden="true">
            <span className="image-cropper__frame" style={{ borderRadius: radius }} />
          </div>
        </div>

        {loadError ? (
          <p className="image-cropper__error" role="alert">
            {t('crop.loadError')}
          </p>
        ) : imageSize === null ? (
          <p className="image-cropper__status" role="status">
            {t('crop.loading')}
          </p>
        ) : null}

        <p className="image-cropper__shortcut">{t('crop.panHint')}</p>

        <div className="image-cropper__controls">
          <label className="image-cropper__zoom">
            <span>{t('crop.zoom')}</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              aria-label={t('crop.zoom')}
              aria-valuetext={t('crop.zoomValue', { value: zoom.toFixed(2) })}
              onChange={(event) => setZoom(clampCropZoom(Number(event.target.value)))}
            />
            <output className="image-cropper__zoom-value">{zoom.toFixed(2)}×</output>
          </label>
          <div className="image-cropper__tools">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setRotation((current) => nextCropRotation(current))}
            >
              <RefreshIcon aria-hidden="true" />
              {t('crop.rotate')}
            </button>
            <button type="button" className="btn btn--sm" onClick={reset}>
              {t('crop.reset')}
            </button>
          </div>
        </div>

        <section className="image-cropper__previews" aria-label={t('crop.previewLabel')}>
          <p className="image-cropper__preview-title">{t('crop.howItLooks')}</p>
          <div className="image-cropper__preview-row">
            {[96, 48].map((size) => (
              <div className="image-cropper__preview" key={size}>
                <div
                  className="image-cropper__thumb"
                  aria-hidden="true"
                  style={{
                    width: size,
                    height: Math.max(1, Math.round(size / aspect)),
                    borderRadius: radius,
                  }}
                >
                  <div
                    className="image-cropper__thumb-frame"
                    style={{
                      width: stage.width,
                      height: stage.height,
                      transform: `scale(${size / stage.width})`,
                    }}
                  >
                    {previewUrl ? (
                      <img
                        className="image-cropper__image"
                        src={previewUrl}
                        alt=""
                        draggable={false}
                        style={imageStyle ?? undefined}
                      />
                    ) : null}
                  </div>
                </div>
                <span className="image-cropper__preview-label">
                  {t('crop.previewSize', { size })}
                </span>
              </div>
            ))}
          </div>
        </section>

        {errorText ? (
          <p className="image-cropper__error" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>

      <footer className="image-cropper__actions">
        <button type="button" className="btn" disabled={busy} onClick={requestCancel}>
          {t('crop.cancel')}
        </button>
        {onUseOriginal ? (
          <button type="button" className="btn" disabled={busy} onClick={useOriginal}>
            {t('crop.useOriginal')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--accent"
          disabled={!canApply}
          aria-busy={busy}
          onClick={() => void apply()}
        >
          {busy ? t('crop.applying') : t('crop.apply')}
        </button>
      </footer>
    </>
  );

  if (inline) {
    return (
      <section className="image-cropper image-cropper--inline" aria-labelledby={titleId}>
        {body}
      </section>
    );
  }

  return (
    <div
      className="image-cropper-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="image-cropper"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {body}
      </div>
    </div>
  );
}
