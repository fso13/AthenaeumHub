/**
 * #93 device image picker contract.
 *
 * The server accepts only raster images for avatars/covers/logos. SVG is
 * deliberately excluded (it is an active document, not a bitmap) and the
 * multipart limit matches `spring.servlet.multipart.max-file-size: 5MB`.
 */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp';
export const IMAGE_UPLOAD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ImageUploadError = 'type' | 'size' | 'empty';

const EXTENSION_MIME: Record<string, (typeof IMAGE_UPLOAD_MIME_TYPES)[number]> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Resolve the MIME the server will see. Some browsers leave `File.type` empty
 * for drag-and-dropped files; the extension is only a fallback, never a reason
 * to accept an unlisted type.
 */
export function imageFileMime(file: File): string | null {
  const declared = file.type.trim().toLowerCase();
  const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if ((IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(normalized)) return normalized;
  if (normalized.length > 0) return null;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[extension] ?? null;
}

export function validateImageFile(file: File): ImageUploadError | null {
  if (file.size <= 0) return 'empty';
  if (imageFileMime(file) === null) return 'type';
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) return 'size';
  return null;
}
