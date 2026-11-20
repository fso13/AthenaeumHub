import { useEffect } from 'react';
import { safeHttpUrl } from '../files/format';
import { t } from '../i18n/ru';
import { useProfileWorkspaceState, useProfileWorkspaceStore } from '../store/ChatProvider';
import type { AvatarTarget } from '../profile/profileWorkspaceStore';
import { DeviceImageUpload } from './DeviceImageUpload';
import { RefreshIcon } from './Icons';

export interface ImageFilePickerProps {
  target: AvatarTarget;
  /** Null for the own avatar; required for a workspace logo. */
  workspaceId?: string | null;
  /** Already-selected file id, rendered as disabled. */
  currentFileId?: string | null;
  pending?: boolean;
  onSelect: (fileId: string) => void;
}

/**
 * P0-4 (#82) image chooser shared by the profile avatar and the workspace logo.
 *
 * The only source is the existing file center (`GET /files?kind=IMAGE`): there
 * is no avatar upload endpoint, so the picker offers scan-approved images of
 * the caller (or of the workspace) and nothing else. Selecting never uploads or
 * mutates a file; the caller submits the chosen `file_id`.
 */
export function ImageFilePicker({
  target,
  workspaceId = null,
  currentFileId = null,
  pending = false,
  onSelect,
}: ImageFilePickerProps) {
  const store = useProfileWorkspaceStore();
  const state = useProfileWorkspaceState();
  const avatar = state.avatar;
  const active = avatar.target === target;
  const status = active ? avatar.imagesStatus : 'idle';
  const images = active ? avatar.images : [];

  useEffect(() => {
    void store.loadAvatarImages(target, workspaceId);
  }, [store, target, workspaceId]);

  return (
    <section className="cover-picker" aria-label={t('imagePicker.title')}>
      <p className="cover-picker__title">{t('imagePicker.title')}</p>
      <p className="pane-sub">{t('imagePicker.hint')}</p>

      <DeviceImageUpload disabled={pending} onUploaded={(fileId) => onSelect(fileId)} />

      {status === 'loading' || status === 'idle' ? (
        <p className="pane-sub" role="status">
          {t('imagePicker.loading')}
        </p>
      ) : null}

      {status === 'error' ? (
        <div>
          <p className="chat-settings-error" role="alert">
            {t('imagePicker.error')}
          </p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void store.loadAvatarImages(target, workspaceId, true)}
          >
            <RefreshIcon aria-hidden="true" />
            {t('imagePicker.retry')}
          </button>
        </div>
      ) : null}

      {status === 'ready' && images.length === 0 ? (
        <p className="pane-sub">{t('imagePicker.empty')}</p>
      ) : null}

      {images.length > 0 ? (
        <ul className="cover-picker__grid">
          {images.map((item) => {
            const artwork = safeHttpUrl(item.media?.artwork_url);
            const label = item.filename?.trim() || item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="cover-picker__item"
                  disabled={pending || item.id === currentFileId}
                  aria-label={`${label}: ${t('imagePicker.select')}`}
                  onClick={() => onSelect(item.id)}
                >
                  {artwork ? (
                    <img src={artwork} alt="" loading="lazy" />
                  ) : (
                    <span className="cover-picker__fallback" aria-hidden="true">
                      {label.slice(0, 12)}
                    </span>
                  )}
                  <span className="cover-picker__name">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
