import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCropper, type ImageCropResult } from './ImageCropper';

const ORIGINAL_CREATE_OBJECT_URL = URL.createObjectURL;
const ORIGINAL_REVOKE_OBJECT_URL = URL.revokeObjectURL;
const ORIGINAL_GET_CONTEXT = HTMLCanvasElement.prototype.getContext;
const ORIGINAL_TO_BLOB = HTMLCanvasElement.prototype.toBlob;

function pngFile(name = 'avatar.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

function loadImage(dialog: HTMLElement, width = 1200, height = 900): HTMLImageElement {
  const image = dialog.querySelector<HTMLImageElement>(
    '.image-cropper__stage .image-cropper__image',
  );
  if (!image) throw new Error('cropper image not rendered');
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
  fireEvent.load(image);
  return image;
}

function stubCanvas() {
  const drawImage = vi.fn();
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low' as ImageSmoothingQuality,
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => context as unknown as CanvasRenderingContext2D,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10])], { type: 'image/png' }));
  }) as typeof HTMLCanvasElement.prototype.toBlob;
  return { context, drawImage };
}

beforeEach(() => {
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:crop-${(counter += 1)}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: ORIGINAL_CREATE_OBJECT_URL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: ORIGINAL_REVOKE_OBJECT_URL,
  });
  HTMLCanvasElement.prototype.getContext = ORIGINAL_GET_CONTEXT;
  HTMLCanvasElement.prototype.toBlob = ORIGINAL_TO_BLOB;
});

function renderCropper(overrides: Partial<Parameters<typeof ImageCropper>[0]> = {}) {
  const onApply = vi.fn<(result: ImageCropResult) => void>();
  const onUseOriginal = vi.fn<(file: File) => void>();
  const onCancel = vi.fn();
  const file = pngFile();
  const view = render(
    <ImageCropper
      file={file}
      onApply={onApply}
      onUseOriginal={onUseOriginal}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...view, file, onApply, onUseOriginal, onCancel };
}

describe('#106 ImageCropper', () => {
  it('previews the file, zooms, pans with arrows and rotates/resets', async () => {
    const { onCancel } = renderCropper();
    const dialog = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    const image = loadImage(dialog);

    const slider = screen.getByRole('slider', { name: 'Масштаб' });
    fireEvent.change(slider, { target: { value: '2' } });
    expect(image.style.transform).toContain('scale(2)');

    const stage = screen.getByRole('group', { name: /Область кадрирования/ });
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(image.style.transform).toContain('translate(10px, 0px)');
    fireEvent.keyDown(stage, { key: 'ArrowDown', shiftKey: true });
    expect(image.style.transform).toContain('translate(10px, 30px)');

    fireEvent.click(screen.getByRole('button', { name: /Повернуть 90°/ }));
    expect(image.style.transform).toContain('rotate(90deg)');

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(image.style.transform).toContain('rotate(0deg)');
    expect(image.style.transform).toContain('scale(1)');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders 48 px and 96 px "how it will look" thumbnails', async () => {
    renderCropper();
    const dialog = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    loadImage(dialog);

    expect(screen.getByText('Как будет выглядеть')).toBeInTheDocument();
    expect(screen.getByText('96 px')).toBeInTheDocument();
    expect(screen.getByText('48 px')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.image-cropper__thumb')).toHaveLength(2);
  });

  it('applies the framed crop through a canvas into a PNG File', async () => {
    const { context, drawImage } = stubCanvas();
    const { onApply } = renderCropper();
    const dialog = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    const image = loadImage(dialog);

    fireEvent.change(screen.getByRole('slider', { name: 'Масштаб' }), { target: { value: '2' } });
    fireEvent.keyDown(screen.getByRole('group', { name: /Область кадрирования/ }), {
      key: 'ArrowRight',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const result = onApply.mock.calls[0]![0];
    expect(result.file).toBeInstanceOf(File);
    expect(result.file.type).toBe('image/png');
    expect(result.file.name).toBe('avatar-crop.png');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(context.translate).toHaveBeenCalled();
    // The visible crop is a zoomed sub-rectangle of the natural bitmap.
    expect(drawImage).toHaveBeenCalledWith(image, -600, -450, 1200, 900);
  });

  it('uploads the original through "Без обрезки"', async () => {
    const { file, onUseOriginal, onApply } = renderCropper();
    await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    fireEvent.click(screen.getByRole('button', { name: 'Без обрезки' }));
    expect(onUseOriginal).toHaveBeenCalledWith(file);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cancels on Escape and traps Tab inside the dialog', async () => {
    const { onCancel } = renderCropper();
    const dialog = await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    loadImage(dialog);

    const close = screen.getByRole('button', { name: 'Закрыть кадрирование' });
    const apply = screen.getByRole('button', { name: 'Применить' });
    apply.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('revokes its object URL on unmount', async () => {
    const { unmount } = renderCropper();
    await screen.findByRole('dialog', { name: 'Кадрирование изображения' });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:crop-1');
  });

  it('supports an inline panel with a custom aspect ratio', async () => {
    const { container } = renderCropper({ inline: true, aspect: 16 / 9, title: 'Обложка' });
    expect(screen.getByRole('region', { name: 'Обложка' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const stage = container.querySelector<HTMLElement>('.image-cropper__stage');
    expect(stage?.style.width).toBe('260px');
    expect(stage?.style.height).toBe('146px');
  });
});
