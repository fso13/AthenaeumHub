import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { isApiError } from '../api/problem';
import {
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_MAX_BYTES,
  validateImageFile,
  type ImageUploadError,
} from '../files/imageUpload';
import { t } from '../i18n/ru';
import { useChatStore } from '../store/ChatProvider';
import { ImageCropper } from './ImageCropper';
import { CloseIcon } from './Icons';

export interface DeviceImageUploadProps {
  /** Applies the uploaded `file_id` via the existing avatar/cover/logo setter. */
  onUploaded: (fileId: string) => boolean | void | Promise<boolean | void>;
  /** Chat scope for covers/icons; omitted for the own profile avatar. */
  chatId?: string | null;
  disabled?: boolean;
  /** Crop window ratio: 1 for avatars/logos, 16/9 for channel covers. */
  aspect?: number;
  /** `false` uploads the chosen file as-is (no cropper). */
  crop?: boolean;
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

function localErrorText(error: ImageUploadError): string {
  if (error === 'type') return t('upload.typeError');
  if (error === 'size') return t('upload.sizeError');
  return t('upload.emptyError');
}

function serverErrorText(error: unknown): string {
  if (!isApiError(error)) return t('upload.unavailableError');
  if (error.code === 'ABORTED') return t('upload.cancelled');
  if (error.status === 413 || error.code === 'IMAGE_TOO_LARGE' || error.code === 'FILE_TOO_LARGE') {
    return t('upload.sizeError');
  }
  if (
    error.status === 415 ||
    error.code === 'IMAGE_TYPE_INVALID' ||
    error.code === 'UNSUPPORTED_MEDIA_TYPE'
  ) {
    return t('upload.typeError');
  }
  if (error.status === 422) return t('upload.invalidError');
  if (error.isNetwork || error.status === 503 || error.status >= 500) {
    return t('upload.unavailableError');
  }
  return t('upload.error');
}

/**
 * #93 "Загрузить с устройства" block shared by the profile avatar, channel
 * cover/icon and workspace logo.
 *
 * - Client-side type/size validation mirrors the server (PNG/JPEG/WebP, ≤5 MiB).
 * - The local file is previewed immediately through an object URL while the
 *   multipart upload runs with real progress; the object URL is revoked on
 *   replacement/unmount.
 * - The server returns `file_id`; only that id is passed to the existing
 *   `POST …/avatar|cover` setters. Nothing is written to storage and the file
 *   bytes never touch the app store. Server-side magic-byte, animation and
 *   extension checks remain authoritative.
 */
export function DeviceImageUpload({
  onUploaded,
  chatId = null,
  disabled = false,
  aspect = 1,
  crop = true,
}: DeviceImageUploadProps) {
  const store = useChatStore();
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<string | null>(null);
  const mounted = useRef(true);

  const [status, setStatus] = useState<UploadStatus>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const revokePreview = () => {
    if (previewRef.current && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(previewRef.current);
    }
    previewRef.current = null;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
      revokePreview();
    };
  }, []);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    revokePreview();
    setPendingFile(null);
    setPreviewUrl(null);
    setFileName(null);
    setProgress(0);
    setErrorText(null);
    setStatus('idle');
    if (inputRef.current) inputRef.current.value = '';
  };

  const apply = async (fileId: string) => {
    try {
      const applied = await onUploaded(fileId);
      if (!mounted.current) return;
      if (applied === false) {
        setStatus('error');
        setErrorText(t('upload.applyError'));
        return;
      }
      setStatus('done');
    } catch {
      if (!mounted.current) return;
      setStatus('error');
      setErrorText(t('upload.applyError'));
    }
  };

  const upload = async (file: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    revokePreview();
    let url: string | null = null;
    if (typeof URL.createObjectURL === 'function') {
      try {
        url = URL.createObjectURL(file);
      } catch {
        url = null;
      }
    }
    previewRef.current = url;
    setPreviewUrl(url);
    setFileName(file.name);
    setStatus('uploading');
    setProgress(0);
    setErrorText(null);
    try {
      const media = await store.uploadImage(file, {
        chatId,
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (!mounted.current) return;
          const denominator = total > 0 ? total : file.size;
          const percent =
            denominator > 0 ? Math.min(100, Math.round((loaded / denominator) * 100)) : 0;
          setProgress(percent);
        },
      });
      if (!mounted.current || controller.signal.aborted) return;
      setProgress(100);
      await apply(media.file_id);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setStatus('error');
      setErrorText(serverErrorText(error));
    }
  };

  const uploadValid = (file: File) => {
    const invalid = validateImageFile(file);
    if (invalid) {
      revokePreview();
      setPreviewUrl(null);
      setStatus('error');
      setErrorText(localErrorText(invalid));
      return;
    }
    void upload(file);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    abortRef.current?.abort();
    abortRef.current = null;
    revokePreview();
    setPendingFile(null);
    setPreviewUrl(null);
    setErrorText(null);
    setProgress(0);
    setFileName(file.name);
    setStatus('idle');

    const invalid = validateImageFile(file);
    if (invalid) {
      setStatus('error');
      setErrorText(localErrorText(invalid));
      // Allow choosing the same file again after fixing it.
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    if (crop) {
      // #106: every avatar/logo/cover is framed before the bytes are uploaded.
      setPendingFile(file);
      return;
    }
    void upload(file);
  };

  const closeCropper = () => {
    setPendingFile(null);
    // Allow choosing the same file again after a cancelled crop.
    if (inputRef.current) inputRef.current.value = '';
  };

  const applyCropped = (cropped: File) => {
    setPendingFile(null);
    uploadValid(cropped);
  };

  const useOriginal = (original: File) => {
    setPendingFile(null);
    uploadValid(original);
  };

  const cancel = () => {
    reset();
  };

  const busy = status === 'uploading';
  const canChoose = !disabled && !busy;

  return (
    <>
      <section className="device-upload" aria-label={t('upload.title')}>
        <div className="device-upload__head">
          <p className="device-upload__title">{t('upload.title')}</p>
          <span className="device-upload__format">{t('upload.formats')}</span>
        </div>

        <label className="device-upload__choose" htmlFor={inputId}>
          {t('upload.choose')}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="device-upload__input"
          type="file"
          accept={IMAGE_UPLOAD_ACCEPT}
          disabled={!canChoose}
          aria-describedby={`${hintId}${errorText ? ` ${hintId}-error` : ''}`}
          onChange={handleChange}
        />
        <p className="pane-sub" id={hintId}>
          {t('upload.hint', { megabytes: Math.round(IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024)) })}
        </p>

        {previewUrl ? (
          <div className="device-upload__preview">
            <img src={previewUrl} alt={t('upload.previewAlt')} />
            <div className="device-upload__meta">
              <span className="device-upload__name">{fileName}</span>
              {busy ? (
                <>
                  <div
                    className="device-upload__progress"
                    role="progressbar"
                    aria-label={t('upload.progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-valuetext={t('upload.progressValue', { percent: progress })}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <span className="pane-sub">{t('upload.uploading', { percent: progress })}</span>
                  <button type="button" className="btn btn--sm" onClick={cancel}>
                    <CloseIcon aria-hidden="true" />
                    {t('upload.cancel')}
                  </button>
                </>
              ) : status === 'done' ? (
                <span className="device-upload__done" role="status">
                  {t('upload.done')}
                </span>
              ) : status === 'error' ? (
                <span className="pane-sub">{t('upload.chooseAnother')}</span>
              ) : null}
              {status === 'error' ? (
                <button type="button" className="btn btn--sm" onClick={reset}>
                  {t('upload.chooseAnother')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {errorText ? (
          <p className="device-upload__error" id={`${hintId}-error`} role="alert">
            {errorText}
          </p>
        ) : null}
      </section>

      {pendingFile ? (
        <ImageCropper
          file={pendingFile}
          aspect={aspect}
          maxOutputSize={1024}
          maxOutputBytes={IMAGE_UPLOAD_MAX_BYTES}
          onApply={(result) => applyCropped(result.file)}
          onUseOriginal={useOriginal}
          onCancel={closeCropper}
        />
      ) : null}
    </>
  );
}
