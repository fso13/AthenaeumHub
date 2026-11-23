/**
 * #106 avatar/profile-picture cropper geometry.
 *
 * The cropper edits a *viewport* (the square/16:9 window the user sees) over a
 * bitmap that can be zoomed (1..4×), panned and rotated in 90° steps. All of
 * this is pure math so the output can be unit-tested without a real canvas:
 *
 * - `coverScale` is the zoom=1 scale that makes the rotated bitmap cover the
 *   whole viewport (`object-fit: cover`), so the crop never shows empty edges;
 * - `panBounds`/`clampCropPan` keep the bitmap over the viewport at every zoom;
 * - `cropOutputSize` derives the PNG pixel size from the visible source pixels,
 *   never upscaling and never exceeding the 1024 px output cap;
 * - `drawCrop` maps the preview transform onto a 2D canvas one-to-one, so the
 *   PNG is exactly the framed preview.
 */

/** Zoom slider range. */
export const CROP_ZOOM_MIN = 1;
export const CROP_ZOOM_MAX = 4;
/** Server/client output cap for one avatar/logo/cover image. */
export const CROP_MAX_OUTPUT_SIZE = 1024;
/** Matches `IMAGE_UPLOAD_MAX_BYTES` (spring multipart `5MB`). */
export const CROP_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export type CropRotation = 0 | 90 | 180 | 270;

export interface CropSize {
  width: number;
  height: number;
}

export interface CropTransform {
  /** 1..4; 1 is `cover` at the smallest scale that fills the viewport. */
  zoom: number;
  /** Pan in viewport (CSS) pixels, already clamped by `clampCropPan`. */
  panX: number;
  panY: number;
  rotation: CropRotation;
}

export const IDENTITY_CROP_TRANSFORM: CropTransform = {
  zoom: CROP_ZOOM_MIN,
  panX: 0,
  panY: 0,
  rotation: 0,
};

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function clampCropZoom(value: number): number {
  if (!Number.isFinite(value)) return CROP_ZOOM_MIN;
  return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, value));
}

export function normalizeCropRotation(value: number): CropRotation {
  if (!Number.isFinite(value)) return 0;
  const normalized = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return normalized as CropRotation;
}

export function nextCropRotation(rotation: CropRotation): CropRotation {
  return normalizeCropRotation(rotation + 90);
}

/** Bounding box of the bitmap after a 90°-step rotation. */
export function rotatedImageSize(image: CropSize, rotation: CropRotation): CropSize {
  const normalized = normalizeCropRotation(rotation);
  return normalized === 90 || normalized === 270
    ? { width: image.height, height: image.width }
    : { width: image.width, height: image.height };
}

/** Scale at zoom=1 that covers the viewport without letterboxing. */
export function coverScale(viewport: CropSize, image: CropSize, rotation: CropRotation): number {
  const rotated = rotatedImageSize(image, rotation);
  if (!positive(viewport.width) || !positive(viewport.height)) return 1;
  if (!positive(rotated.width) || !positive(rotated.height)) return 1;
  return Math.max(viewport.width / rotated.width, viewport.height / rotated.height);
}

export interface CropPanBounds {
  maxX: number;
  maxY: number;
}

/** Largest pan that still keeps every viewport pixel covered. */
export function panBounds(
  viewport: CropSize,
  image: CropSize,
  rotation: CropRotation,
  zoom: number,
): CropPanBounds {
  const rotated = rotatedImageSize(image, rotation);
  const scale = coverScale(viewport, image, rotation) * clampCropZoom(zoom);
  return {
    maxX: Math.max(0, (rotated.width * scale - viewport.width) / 2),
    maxY: Math.max(0, (rotated.height * scale - viewport.height) / 2),
  };
}

export interface CropPan {
  panX: number;
  panY: number;
}

/** Clamp a pan to the current zoom/rotation; non-finite input becomes 0. */
export function clampCropPan(
  panX: number,
  panY: number,
  viewport: CropSize,
  image: CropSize,
  rotation: CropRotation,
  zoom: number,
): CropPan {
  const bounds = panBounds(viewport, image, rotation, zoom);
  const safeX = Number.isFinite(panX) ? panX : 0;
  const safeY = Number.isFinite(panY) ? panY : 0;
  return {
    panX: Math.min(bounds.maxX, Math.max(-bounds.maxX, safeX)),
    panY: Math.min(bounds.maxY, Math.max(-bounds.maxY, safeY)),
  };
}

/** Clamp the whole transform (zoom and rotation are normalized too). */
export function clampCropTransform(
  transform: CropTransform,
  viewport: CropSize,
  image: CropSize,
): CropTransform {
  const rotation = normalizeCropRotation(transform.rotation);
  const zoom = clampCropZoom(transform.zoom);
  return {
    zoom,
    rotation,
    ...clampCropPan(transform.panX, transform.panY, viewport, image, rotation, zoom),
  };
}

/**
 * Pixel size of the exported PNG. Only the visible source pixels are kept; a
 * small source is never upscaled and the longest side never exceeds `maxOutput`
 * (clamped to 1024). The result keeps the viewport aspect ratio.
 */
export function cropOutputSize(
  viewport: CropSize,
  image: CropSize,
  rotation: CropRotation,
  zoom: number,
  maxOutput = CROP_MAX_OUTPUT_SIZE,
): CropSize {
  if (!positive(viewport.width) || !positive(viewport.height)) {
    return { width: 1, height: 1 };
  }
  const scale = coverScale(viewport, image, rotation) * clampCropZoom(zoom);
  if (!positive(scale)) return { width: 1, height: 1 };
  const visibleWidth = viewport.width / scale;
  const visibleHeight = viewport.height / scale;
  const cap = Math.max(1, Math.min(CROP_MAX_OUTPUT_SIZE, Math.round(maxOutput)));
  const ratio = Math.min(1, cap / Math.max(visibleWidth, visibleHeight));
  return {
    width: Math.max(1, Math.round(visibleWidth * ratio)),
    height: Math.max(1, Math.round(visibleHeight * ratio)),
  };
}

/**
 * The subset of `CanvasRenderingContext2D` used by `drawCrop`. Tests provide a
 * recording fake; the browser provides the real context.
 */
export interface CropCanvasContext {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: ImageSmoothingQuality;
}

/**
 * Draw exactly the framed viewport into the output canvas.
 *
 * The preview places the bitmap at the viewport centre, then applies
 * `translate(pan) → rotate → scale(coverScale × zoom)`. The canvas applies the
 * same operations with the output-pixel scale folded in, so the drawn rect is
 * the preview rect scaled by `output.width / viewport.width`.
 */
export function drawCrop(
  context: CropCanvasContext,
  source: CanvasImageSource,
  image: CropSize,
  viewport: CropSize,
  transform: CropTransform,
  output: CropSize,
): void {
  const rotation = normalizeCropRotation(transform.rotation);
  const zoom = clampCropZoom(transform.zoom);
  const scale = coverScale(viewport, image, rotation) * zoom;
  const scaleX = output.width / viewport.width;
  const scaleY = output.height / viewport.height;

  context.save();
  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.translate(output.width / 2, output.height / 2);
    context.scale(scaleX, scaleY);
    context.translate(transform.panX, transform.panY);
    context.rotate((rotation * Math.PI) / 180);
    context.scale(scale, scale);
    context.drawImage(source, -image.width / 2, -image.height / 2, image.width, image.height);
  } finally {
    context.restore();
  }
}

/** Safe download/upload name for the generated PNG. */
export function cropFileName(originalName: string): string {
  const withoutExtension = originalName.replace(/\.[^./\\]+$/, '');
  const printable = Array.from(withoutExtension)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  const base = printable
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'image'}-crop.png`;
}
