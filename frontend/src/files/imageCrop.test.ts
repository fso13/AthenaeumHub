import { describe, expect, it } from 'vitest';
import {
  CROP_MAX_OUTPUT_SIZE,
  clampCropPan,
  clampCropZoom,
  coverScale,
  cropFileName,
  cropOutputSize,
  drawCrop,
  nextCropRotation,
  normalizeCropRotation,
  panBounds,
  rotatedImageSize,
  type CropCanvasContext,
  type CropSize,
} from './imageCrop';

const VIEWPORT: CropSize = { width: 260, height: 260 };
const IMAGE: CropSize = { width: 1000, height: 800 };

function recordingContext() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const context: CropCanvasContext = {
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    scale: record('scale'),
    drawImage: record('drawImage') as CropCanvasContext['drawImage'],
  };
  return { context, calls };
}

describe('#106 crop geometry', () => {
  it('rotates the bitmap bounding box in 90° steps', () => {
    expect(rotatedImageSize(IMAGE, 0)).toEqual({ width: 1000, height: 800 });
    expect(rotatedImageSize(IMAGE, 90)).toEqual({ width: 800, height: 1000 });
    expect(rotatedImageSize(IMAGE, 180)).toEqual({ width: 1000, height: 800 });
    expect(rotatedImageSize(IMAGE, 270)).toEqual({ width: 800, height: 1000 });
    expect(normalizeCropRotation(450)).toBe(90);
    expect(nextCropRotation(270)).toBe(0);
  });

  it('covers the viewport at zoom 1 and clamps the zoom to 1..4', () => {
    // max(260 / 1000, 260 / 800)
    expect(coverScale(VIEWPORT, IMAGE, 0)).toBeCloseTo(0.325, 6);
    // rotation swaps the limiting dimension
    expect(coverScale(VIEWPORT, IMAGE, 90)).toBeCloseTo(0.325, 6);
    expect(clampCropZoom(-5)).toBe(1);
    expect(clampCropZoom(9)).toBe(4);
    expect(clampCropZoom(Number.NaN)).toBe(1);
  });

  it('allows more pan as the zoom grows and never leaves a gap', () => {
    expect(panBounds(VIEWPORT, IMAGE, 0, 1)).toEqual({ maxX: 32.5, maxY: 0 });
    expect(panBounds(VIEWPORT, IMAGE, 0, 2)).toEqual({ maxX: 195, maxY: 130 });
    expect(clampCropPan(999, -999, VIEWPORT, IMAGE, 0, 2)).toEqual({ panX: 195, panY: -130 });
    expect(clampCropPan(Number.POSITIVE_INFINITY, 3, VIEWPORT, IMAGE, 0, 1)).toEqual({
      panX: 0,
      panY: 0,
    });
  });

  it('exports visible source pixels, caps at 1024 and never upscales', () => {
    expect(cropOutputSize(VIEWPORT, IMAGE, 0, 1)).toEqual({ width: 800, height: 800 });
    expect(cropOutputSize(VIEWPORT, IMAGE, 0, 2)).toEqual({ width: 400, height: 400 });
    expect(cropOutputSize(VIEWPORT, IMAGE, 0, 1, 320)).toEqual({ width: 320, height: 320 });
    expect(cropOutputSize(VIEWPORT, IMAGE, 0, 1, 4096)).toEqual({ width: 800, height: 800 });
    expect(cropOutputSize(VIEWPORT, { width: 4000, height: 4000 }, 0, 1)).toEqual({
      width: CROP_MAX_OUTPUT_SIZE,
      height: CROP_MAX_OUTPUT_SIZE,
    });
    expect(cropOutputSize(VIEWPORT, { width: 100, height: 100 }, 0, 1)).toEqual({
      width: 100,
      height: 100,
    });
    expect(cropOutputSize({ width: 320, height: 180 }, IMAGE, 0, 1)).toEqual({
      width: 1000,
      height: 563,
    });
  });

  it('maps the preview transform (zoom + pan) onto the output canvas', () => {
    const { context, calls } = recordingContext();
    const source = {} as CanvasImageSource;
    drawCrop(
      context,
      source,
      IMAGE,
      VIEWPORT,
      { zoom: 2, panX: 15, panY: -5, rotation: 0 },
      {
        width: 400,
        height: 400,
      },
    );

    const translate = calls.filter((call) => call.name === 'translate').map((call) => call.args);
    expect(translate[0]).toEqual([200, 200]);
    // The pan is applied in viewport units after the output scale; the canvas
    // matrix multiplies it by `output.width / viewport.width` itself.
    expect(translate[1]).toEqual([15, -5]);

    const scales = calls.filter((call) => call.name === 'scale').map((call) => call.args);
    expect(scales[0]![0]).toBeCloseTo(400 / 260, 6);
    expect(scales[1]).toEqual([0.65, 0.65]);

    const draw = calls.find((call) => call.name === 'drawImage');
    expect(draw?.args).toEqual([source, -500, -400, 1000, 800]);
    expect(calls[0]?.name).toBe('save');
    expect(calls.at(-1)?.name).toBe('restore');
  });

  it('rotates the canvas drawing by the chosen right angle', () => {
    const { context, calls } = recordingContext();
    drawCrop(
      context,
      {} as CanvasImageSource,
      IMAGE,
      VIEWPORT,
      { zoom: 1, panX: 0, panY: 0, rotation: 90 },
      { width: 400, height: 400 },
    );
    const rotate = calls.find((call) => call.name === 'rotate');
    expect(rotate?.args[0]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('sanitizes the generated PNG name', () => {
    expect(cropFileName('avatar.png')).toBe('avatar-crop.png');
    expect(cropFileName('Фото 1.JPEG')).toBe('Фото 1-crop.png');
    expect(cropFileName('')).toBe('image-crop.png');
    expect(cropFileName('../<bad>.png')).toBe('..-bad--crop.png');
  });
});
